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
 * `{"applied": true}`. Everything else — `applied:false`, any non-200, a
 * network error, a timeout, an unparseable body — exits 1. There is
 * deliberately NO bypass flag: a deploy with no new migrations passes
 * naturally, because production already has the newest one.
 *
 * ⚠️ FIRST-DEPLOY ORDERING. Production does not serve `/health/schema` at all
 * until the deploy that SHIPS this script's companion routes lands — so the
 * Cloudflare dashboard's build-command change that actually invokes this
 * script must be made AFTER that deploy is live, never before. See
 * docs/runbooks/deploy.md.
 *
 * Usage (from a Worker's Cloudflare Workers Builds build command):
 *   node scripts/check-migrations-applied.mjs && <the existing build command>
 *
 * Env:
 *   MIGRATION_GATE_BASE_URL   override the production host this polls
 *                             (default https://community.thinkersjournal.com).
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path to apps/api/migrations, independent of the process cwd. */
const MIGRATIONS_DIR = fileURLToPath(new URL("../apps/api/migrations", import.meta.url));

const DEFAULT_BASE_URL = "https://community.thinkersjournal.com";
const FETCH_TIMEOUT_MS = 20_000;

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
 * Pure: picks the newest migration (by filename) that is NOT marked
 * after-code, skipping over any that are. Returns the migration's name
 * WITHOUT its `.sql` extension — matching what node-pg-migrate records in
 * `pgmigrations` (see apps/api/scripts/migrate.mjs) — or `null` if every
 * migration present is marked after-code (nothing to gate on).
 *
 * `dirEntries` need not be pre-sorted or pre-filtered; this sorts and keeps
 * only `*.sql` itself, so a real `fs.readdirSync()` result can be passed
 * straight through.
 */
export function pickGateMigration(dirEntries, readHead) {
  const sqlFiles = dirEntries.filter((name) => name.endsWith(".sql")).sort();

  for (let i = sqlFiles.length - 1; i >= 0; i--) {
    const file = sqlFiles[i];
    const head = readHead(file);
    const isAfterCode = head.some((line) => line.trim() === AFTER_CODE_MARKER);
    if (!isAfterCode) {
      return file.slice(0, -".sql".length);
    }
    // else: this is the newest file, but it runs AFTER its own code — gate on
    // whichever migration comes before it instead.
  }
  return null;
}

/**
 * Pure (modulo the promise it's handed): turns a `fetch(...)` call — already
 * in flight, not yet awaited — into a pass/fail verdict, catching EVERY way
 * it can go wrong itself so no caller has to duplicate the try/catch. Pass
 * requires ALL THREE: the promise resolves, the response is HTTP 200, and its
 * body parses as JSON with `applied === true`. Anything else — a rejected
 * promise (network error, our own timeout abort), a non-200, or a body that
 * is not valid JSON — is a fail, with a `reason` string for the caller to
 * print. `applied: false` and `applied: null` (the api's own 503 shape, see
 * health-schema.ts) are both ordinary fails, distinguished only by `reason`.
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

async function main() {
  const migrationName = pickGateMigration(readdirSync(MIGRATIONS_DIR), readMigrationHead);

  if (migrationName === null) {
    // Every migration present is marked after-code — nothing for the gate to
    // check (an edge case the repo has never actually reached).
    console.log("MIGRATION GATE: no gate-eligible migration found — nothing to verify.");
    return;
  }

  const baseUrl = process.env.MIGRATION_GATE_BASE_URL ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/health/schema?migration=${encodeURIComponent(migrationName)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let result;
  try {
    result = await evaluate(fetch(url, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }

  if (result.pass) {
    console.log(`MIGRATION GATE: production has applied ${migrationName} — proceeding.`);
    return;
  }

  if (result.reason.startsWith("applied:false")) {
    console.log(
      `MIGRATION GATE: production has not applied ${migrationName} — apply it ` +
        `(see docs/runbooks/deploy.md), then retry the build.`,
    );
  } else {
    console.log(`MIGRATION GATE: could not verify (${result.reason}) — refusing to deploy.`);
  }
  process.exitCode = 1;
}

await main();
