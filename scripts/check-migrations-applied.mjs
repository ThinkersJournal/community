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
 * ⚠️ `await main()` RUNS UNCONDITIONALLY — NO ENTRY-POINT GUARD (#116 fix
 * round 2 ruling: a guard here previously could fail open — see
 * `scripts/lib/migration-gate.mjs`'s header for the full story). Every pure
 * piece this file used to export now lives there, so this file needs no
 * conditional to protect and just calls `main()` like any other script.
 * `apps/api/test/check-migrations-applied.node.test.ts` pins, at the source
 * level, that no guard has crept back in.
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
import { fileURLToPath } from "node:url";

import {
  AFTER_CODE_HEAD_LINES,
  MIGRATION_NAME_RE,
  evaluate,
  findDisallowedMigrationFiles,
  pickGateMigration,
} from "./lib/migration-gate.mjs";

/** Absolute path to apps/api/migrations, independent of the process cwd. */
const MIGRATIONS_DIR = fileURLToPath(new URL("../apps/api/migrations", import.meta.url));

const DEFAULT_BASE_URL = "https://community.thinkersjournal.com";
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Read a migration file's first `AFTER_CODE_HEAD_LINES` lines. Real
 * filesystem I/O — this is why it lives in the CLI file, not the pure
 * library — injected into `pickGateMigration` as a parameter so tests can
 * fake file contents without touching disk.
 */
function readMigrationHead(name) {
  const text = readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8");
  return text.split(/\r?\n/).slice(0, AFTER_CODE_HEAD_LINES);
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

// ⚠️ UNCONDITIONAL — NO ENTRY-POINT GUARD (#116 fix round 2 ruling). See this
// file's header for why round 1's guard was removed rather than fixed in
// place. Pinned at the source level by
// apps/api/test/check-migrations-applied.node.test.ts.
await main();
