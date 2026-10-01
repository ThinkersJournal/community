/**
 * PURE HELPERS for the deploy-time migration gate (#116, shape A) — split out
 * of `scripts/check-migrations-applied.mjs` itself (fix round 2 ruling).
 *
 * ⚠️ WHY THIS FILE EXISTS. Fix round 1 guarded that CLI's `await main()` with
 * `import.meta.url === pathToFileURL(process.argv[1]).href`, so importing the
 * module for its pure exports (as a test does) would not ALSO fetch
 * production. The controller found that guard can FAIL OPEN: Node realpaths
 * `import.meta.url` for the actual main module but only `path.resolve`s
 * `process.argv[1]`, so a symlinked path in the build environment — or a
 * Windows drive-letter/case difference — can make the comparison wrongly
 * `false`. For this script that means THE GATE SILENTLY DOES NOTHING AND
 * EXITS 0 — a deploy passes unchecked, which is the one failure this script
 * must never have.
 *
 * The fix is structural, not a better string comparison: every function here
 * has NO top-level side effects (no fetch, no filesystem read, no
 * `process.exit`/`process.exitCode` write) and does not import `node:fs` or
 * anything network-capable. `scripts/check-migrations-applied.mjs` imports
 * this file and ALSO calls its own `main()` completely unconditionally — with
 * no comparison of any kind to get wrong — because importing THIS file alone
 * can never run the gate. A test exercises the pure logic by importing only
 * this module; the CLI's own unconditional `await main();` is pinned by a
 * separate source-level test (see apps/api/test/check-migrations-applied
 * .node.test.ts) precisely so a guard like round 1's cannot be reintroduced
 * silently.
 */

/**
 * Must match `apps/api/src/routes/health-schema.ts`'s own `MIGRATION_NAME_RE`
 * byte-for-byte (fix round 1, item 5) — checked by the CLI BEFORE the fetch,
 * so a malformed name on disk fails with a specific, actionable message
 * instead of an opaque 400 from the api.
 */
export const MIGRATION_NAME_RE = /^\d{4}_[a-z0-9_]{1,100}$/;

/**
 * File extensions this gate does NOT understand (fix round 1, item 7). Any of
 * these present in `apps/api/migrations` means something non-`.sql` landed
 * there — node-pg-migrate itself supports JS migrations, but this repo's own
 * convention (and `pickGateMigration` below) only ever reasons about `.sql`
 * files, so a JS/TS migration would be silently invisible to the gate rather
 * than erroring loudly. Fail closed instead.
 */
export const DISALLOWED_EXTENSIONS = [".js", ".cjs", ".mjs", ".ts"];

/**
 * A migration is "after-code" — its destructive change must run AFTER the
 * code that stops depending on the old shape, so it must never block that
 * code's own deploy (spec §2's contract case). Marked by this exact line
 * anywhere in its first 20 lines; see docs/runbooks/deploy.md's "Destructive
 * migrations" section for how/when to add it to a migration file.
 */
export const AFTER_CODE_MARKER = "-- deploy: after-code";
export const AFTER_CODE_HEAD_LINES = 20;

/**
 * Pure: which entries of a directory listing this gate refuses to run next
 * to (fix round 1, item 7) — see `DISALLOWED_EXTENSIONS` above. Returns the
 * offending names, sorted, or `[]` when none are present.
 */
export function findDisallowedMigrationFiles(dirEntries) {
  return dirEntries
    .filter((name) => DISALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext)))
    .sort();
}

/**
 * Pure: picks the newest migration (by filename) that is NOT marked
 * after-code, skipping over any that are. `readHead(name)` must return that
 * file's first `AFTER_CODE_HEAD_LINES` lines — injected rather than read from
 * disk here, so this stays pure and testable without a real migrations
 * directory. Returns:
 *
 *   - `{ name, reason: null }` — `name` is the migration's name WITHOUT its
 *     `.sql` extension, matching what node-pg-migrate records in
 *     `pgmigrations` (see apps/api/scripts/migrate.mjs).
 *   - `{ name: null, reason: "no-sql-files" }` — the directory listing
 *     contains no `*.sql` entries at all (fix round 1, item 6 — a broken
 *     checkout, never silently treated the same as "nothing to gate on").
 *   - `{ name: null, reason: "all-after-code" }` — every `*.sql` file present
 *     is marked after-code; nothing for the gate to check, and NOT an error.
 *
 * `dirEntries` need not be pre-sorted or pre-filtered; this sorts and keeps
 * only `*.sql` itself, so a real `fs.readdirSync()` result can be passed
 * straight through.
 */
export function pickGateMigration(dirEntries, readHead) {
  const sqlFiles = dirEntries.filter((name) => name.endsWith(".sql")).sort();

  if (sqlFiles.length === 0) {
    return { name: null, reason: "no-sql-files" };
  }

  for (let i = sqlFiles.length - 1; i >= 0; i--) {
    const file = sqlFiles[i];
    const head = readHead(file);
    const isAfterCode = head.some((line) => line.trim() === AFTER_CODE_MARKER);
    if (!isAfterCode) {
      return { name: file.slice(0, -".sql".length), reason: null };
    }
    // else: this is the newest file, but it runs AFTER its own code — gate on
    // whichever migration comes before it instead.
  }
  return { name: null, reason: "all-after-code" };
}

/**
 * Pure (modulo the promise it's handed): turns a `fetch(...)` call — already
 * in flight, not yet awaited — into a pass/fail verdict, catching EVERY way
 * it can go wrong itself so no caller has to duplicate the try/catch. Pass
 * requires ALL THREE: the promise resolves, the response is HTTP 200, and its
 * body parses as JSON with `applied === true`. Anything else — a rejected
 * promise (network error, our own timeout abort, a redirect refused by
 * `redirect: "error"`), a non-200, or a body that is not valid JSON — is a
 * fail, with a `reason` string for the caller to print. `applied: false` and
 * `applied: null` (the api's own 503 shape, see health-schema.ts) are both
 * ordinary fails, distinguished only by `reason`.
 *
 * ⚠️ DOES NOT CALL `fetch` ITSELF — it is handed an in-flight promise (or a
 * rejected one) and only observes it. This module never references the
 * global `fetch` at all, which is what makes "importing this file calls no
 * fetch" a meaningful, checkable property (see the test file).
 */
export async function evaluate(responsePromise) {
  let response;
  try {
    response = await responsePromise;
  } catch (err) {
    return { pass: false, reason: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (response.status !== 200) {
    return { pass: false, reason: `HTTP ${response.status}` };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { pass: false, reason: "response body was not valid JSON" };
  }

  if (body && body.applied === true) {
    return { pass: true, reason: "applied:true" };
  }
  return { pass: false, reason: `applied:${JSON.stringify(body?.applied)}` };
}
