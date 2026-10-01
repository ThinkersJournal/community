#!/usr/bin/env node
/**
 * THE DEPLOY-TIME MIGRATION GATE (#116, shape A) — run as the FIRST step of
 * each Worker's Cloudflare Workers Builds build command, so code that depends
 * on an unapplied migration never deploys. This is what closes the #107/0019
 * incident: `0019_account_deletion.sql` was merged, its dependent code
 * auto-deployed within ~1 minute, and the migration itself was never applied
 * against production — four public routes 404'd for hours before anyone
 * noticed (see docs/superpowers/specs/2026-09-27-deploy-automation-design.md).
 *
 * No standing CI credential (CireSnave ruled option 2): this script holds no
 * database connection string of its own. It asks the already-deployed
 * production `web` Worker, over its one public `GET /health/schema` route,
 * whether a single named migration has been applied — see
 * apps/api/src/routes/health-schema.ts and apps/web/src/pages/health/schema.ts.
 *
 * ⚠️ FAIL CLOSED, ALWAYS. Exit 0 ONLY on an HTTP 200 with JSON
 * `{"applied": true}`, or when every migration present is deliberately marked
 * after-code (nothing to gate on). Everything else — `applied:false`, any
 * non-200, a network/redirect error, a timeout, an unparseable body, a
 * malformed migration filename, a non-`.sql` file in the migrations
 * directory, or an EMPTY migrations directory — exits 1. There is
 * deliberately NO bypass flag: a deploy with no new migrations passes
 * naturally, because production already has the newest one.
 *
 * ⚠️ FIRST-DEPLOY ORDERING. Production does not serve `/health/schema` at all
 * until the deploy that SHIPS this script's companion routes lands — so the
 * Cloudflare dashboard's build-command change that actually invokes this
 * script must be made AFTER that deploy is live, never before. See
 * docs/runbooks/deploy.md, including its break-glass section for what to do
 * if the gate itself starts blocking every deploy (api/DB down, a `pgmigrations`
 * grant removed, etc).
 *
 * ⚠️ `await main()` IS GUARDED (fix round 1, item 1) — it runs ONLY when this
 * file is executed directly (`node scripts/check-migrations-applied.mjs`),
 * NOT when it is `import`ed (as the test below does, to reach the pure
 * exports). Without the guard, importing this module for its pure pieces
 * would ALSO fetch production on every test run, in every CI run, with no
 * network available and no reason to.
 *
 * Usage (from a Worker's Cloudflare Workers Builds build command):
 *   node scripts/check-migrations-applied.mjs && <the existing build command>
 *
 * ⚠️ THE "Root directory" SETTING MATTERS. Workers Builds runs the build
 * command from whatever "Root directory" that Worker's project is configured
 * with, NOT necessarily this repo's root — see docs/runbooks/deploy.md's "build
 * root directory" section for the exact path to use for each case. This
 * script itself does not care: `MIGRATIONS_DIR` below is resolved from
 * `import.meta.url` (this file's own location), never from `process.cwd()`,
 * so it finds `apps/api/migrations` correctly regardless of where the shell
 * invoking it happens to be sitting.
 *
 * Env:
 *   MIGRATION_GATE_BASE_URL   override the production host this polls.
 *                             FOR LOCAL TESTING ONLY — see docs/runbooks/
 *                             deploy.md. Must never be set in the Workers
 *                             Builds environment: it would silently point the
 *                             gate at a different host than the one actually
 *                             being deployed. The base URL actually used is
 *                             printed on every run specifically so a build
 *                             log shows any override.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Absolute path to apps/api/migrations, independent of the process cwd. */
const MIGRATIONS_DIR = fileURLToPath(new URL("../apps/api/migrations", import.meta.url));

const DEFAULT_BASE_URL = "https://community.thinkersjournal.com";
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Must match `apps/api/src/routes/health-schema.ts`'s own `MIGRATION_NAME_RE`
 * byte-for-byte (fix round 1, item 5) — checked here, BEFORE the fetch, so a
 * malformed name on disk fails with a specific, actionable message instead of
 * an opaque 400 from the api.
 */
const MIGRATION_NAME_RE = /^\d{4}_[a-z0-9_]{1,100}$/;

/**
 * File extensions this gate does NOT understand (fix round 1, item 7). Any of
 * these present in `apps/api/migrations` means something non-`.sql` landed
 * there — node-pg-migrate itself supports JS migrations, but this repo's own
 * convention (and `pickGateMigration` below) only ever reasons about `.sql`
 * files, so a JS/TS migration would be silently invisible to the gate rather
 * than erroring loudly. Fail closed instead.
 */
const DISALLOWED_EXTENSIONS = [".js", ".cjs", ".mjs", ".ts"];

/**
 * A migration is "after-code" — its destructive change must run AFTER the
 * code that stops depending on the old shape, so it must never block that
 * code's own deploy (spec §2's contract case). Marked by this exact line
 * anywhere in its first 20 lines; see docs/runbooks/deploy.md's "Destructive
 * migrations" section for how/when to add it to a migration file.
 */
const AFTER_CODE_MARKER = "-- deploy: after-code";
const AFTER_CODE_HEAD_LINES = 20;

/**
 * Read a migration file's first `AFTER_CODE_HEAD_LINES` lines. The real
 * filesystem implementation `pickGateMigration` is called with below;
 * injected as a parameter so tests can fake file contents without touching
 * disk.
 */
function readMigrationHead(name) {
  const text = readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8");
  return text.split(/\r?\n/).slice(0, AFTER_CODE_HEAD_LINES);
}

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
 * after-code, skipping over any that are. Returns:
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

export async function main() {
  const dirEntries = readdirSync(MIGRATIONS_DIR);

  const disallowed = findDisallowedMigrationFiles(dirEntries);
  if (disallowed.length > 0) {
    console.log(
      `MIGRATION GATE: apps/api/migrations contains non-.sql migration file(s) this ` +
        `gate cannot understand: ${disallowed.join(", ")} — the gate only understands ` +
        `.sql files.`,
    );
    process.exitCode = 1;
    return;
  }

  const picked = pickGateMigration(dirEntries, readMigrationHead);

  if (picked.name === null) {
    if (picked.reason === "no-sql-files") {
      console.log(
        "MIGRATION GATE: apps/api/migrations contains no .sql files at all — broken " +
          "checkout? Refusing to deploy.",
      );
      process.exitCode = 1;
      return;
    }
    // "all-after-code" — every migration present is marked after-code, so
    // there is nothing for the gate to verify. NOT an error.
    console.log(
      "MIGRATION GATE: every migration present is marked `-- deploy: after-code` — " +
        "nothing to verify.",
    );
    return;
  }

  if (!MIGRATION_NAME_RE.test(picked.name)) {
    console.log(
      `MIGRATION GATE: migration file name ${picked.name} doesn't match the api's ` +
        `accepted pattern — rename it`,
    );
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.MIGRATION_GATE_BASE_URL ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/health/schema?migration=${encodeURIComponent(picked.name)}`;

  // Printed unconditionally, success or failure, so a build log always shows
  // which host was actually checked — the one way `MIGRATION_GATE_BASE_URL`
  // being set somewhere it shouldn't be (fix round 1, item 8) becomes visible
  // rather than a silent, hard-to-diagnose wrong-host check.
  console.log(`MIGRATION GATE: checking ${baseUrl} for migration ${picked.name}...`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let result;
  try {
    result = await evaluate(
      // `redirect: "error"` (fix round 1, item 8) — a redirect here means the
      // gate is no longer talking to the host it printed above, which is
      // exactly the silent-wrong-host failure this exists to surface loudly
      // instead of transparently following.
      fetch(url, { signal: controller.signal, redirect: "error" }),
    );
  } finally {
    clearTimeout(timer);
  }

  if (result.pass) {
    console.log(`MIGRATION GATE: production has applied ${picked.name} — proceeding.`);
    return;
  }

  if (result.reason.startsWith("applied:false")) {
    console.log(
      `MIGRATION GATE: production has not applied ${picked.name} — apply it ` +
        `(see docs/runbooks/deploy.md), then retry the build.`,
    );
  } else {
    console.log(`MIGRATION GATE: could not verify (${result.reason}) — refusing to deploy.`);
  }
  process.exitCode = 1;
}

// ⚠️ GUARDED, DELIBERATELY (fix round 1, item 1) — see this file's header.
// Runs `main()` only when this file is the process's entry point (a direct
// `node scripts/check-migrations-applied.mjs` invocation), never when it is
// `import`ed for its pure exports (pickGateMigration, evaluate,
// findDisallowedMigrationFiles). `process.argv[1]` is undefined in some
// embedding contexts (never here, but defensively checked) — the `&&` short-
// circuits rather than throwing if so.
// ⚠️ GUARDED, DELIBERATELY (fix round 1, item 1) — see this file's header.
// Runs `main()` only when this file is the process's entry point (a direct
// `node scripts/check-migrations-applied.mjs` invocation), never when it is
// `import`ed for its pure exports (pickGateMigration, evaluate,
// findDisallowedMigrationFiles). `process.argv[1]` is undefined in some
// embedding contexts (never here, but defensively checked) — the `&&` short-
// circuits rather than throwing if so.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
