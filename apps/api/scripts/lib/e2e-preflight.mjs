// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * PURE LOGIC of the e2e preflight (#84), split from `scripts/e2e-preflight.mjs`
 * so a test can drive it with a fake ledger query and no Postgres.
 *
 * WHY. `pnpm test:e2e` writes real users to the persistent LOCAL dev database.
 * When that database is behind `apps/api/migrations` (an old volume, a partly
 * advanced ledger), the web Worker's `/` calls `GET /public/discover`, which
 * 503s until Playwright's webServer timeout (180 s) expires: a hang with no
 * pointer to the cause. CI is fresh and migrates first, so it never sees this.
 * This check turns that hang into one line naming the fix.
 *
 * Local-only by construction: a non-loopback host is never connected to
 * (the e2e writes users there; a remote target is not ours to probe).
 *
 * No side effects at import time and no `pg` import: the caller injects
 * `queryApplied`.
 */
import { describeTarget, isLoopbackHost } from "./migrate-args.mjs";

export const MIGRATE_COMMAND = "pnpm --filter @thinkersjournal/api run migrate";

/** Names node-pg-migrate records in `pgmigrations`: the file name without `.sql`. Sorted. */
export function listMigrationNames(dirEntries) {
  return dirEntries
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, -".sql".length))
    .sort();
}

const fail = (status, message, extra = {}) => ({ ok: false, status, message, ...extra });

/**
 * Maps a failed ledger read to a verdict. `null` means "no pgmigrations table yet"
 * (42P01), which the caller treats as an empty ledger rather than a failure.
 */
function ledgerReadFailure(err, target) {
  const code = err && typeof err === "object" ? err.code : undefined;
  if (code === "42P01") return null;
  if (code === "3D000") {
    return fail(
      "no-database",
      `e2e preflight: database "${target.database}" does not exist on ${target.host}:${target.port}. ` +
        `Create it (docker compose does), then run: ${MIGRATE_COMMAND}`,
    );
  }
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
    return fail(
      "unreachable",
      `e2e preflight: Postgres is not reachable at ${target.host}:${target.port} (${code}). ` +
        `Start it (docker compose up -d --wait db) and re-run.`,
    );
  }
  const where = `${target.host}:${target.port}/${target.database}`;
  return fail("error", `e2e preflight: could not read the migration ledger on ${where}: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * @param {object} args
 * @param {string} args.databaseUrl the e2e's dev database URL
 * @param {string[]} args.migrationNames from `listMigrationNames`
 * @param {() => Promise<string[]>} args.queryApplied `SELECT name FROM pgmigrations`
 * @returns {Promise<{ok: boolean, status: string, message: string}>}
 */
export async function checkDevDb({ databaseUrl, migrationNames, queryApplied }) {
  if (migrationNames.length === 0) {
    return fail("error", "e2e preflight: no .sql files in apps/api/migrations (broken checkout?)");
  }

  let target;
  try {
    target = describeTarget(databaseUrl);
  } catch (err) {
    return fail("error", `e2e preflight: ${err instanceof Error ? err.message : String(err)}`);
  }
  const where = `${target.host}:${target.port}/${target.database}`;

  if (!isLoopbackHost(target.host)) {
    return {
      ok: true,
      status: "skipped-nonlocal",
      message: `e2e preflight: SKIPPED, ${where} is not a local database (this check only reads local ones).`,
    };
  }

  let applied;
  try {
    applied = await queryApplied();
  } catch (err) {
    const failure = ledgerReadFailure(err, target);
    if (failure !== null) return failure;
    applied = []; // no pgmigrations table at all: nothing has been migrated
  }

  const appliedSet = new Set(applied);
  const missing = migrationNames.filter((n) => !appliedSet.has(n));
  if (missing.length === 0) {
    return { ok: true, status: "ok", message: `e2e preflight: ${where} has all ${migrationNames.length} migrations.` };
  }

  const ledger = migrationNames.length - missing.length;
  const shown = missing.length > 5 ? `${missing.slice(0, 5).join(", ")}, ... (${missing.length} in all)` : missing.join(", ");
  return fail(
    "unmigrated",
    `e2e preflight: dev DB unmigrated (ledger ${ledger} < files ${migrationNames.length}) on ${where}; ` +
      `missing: ${shown}. Run: ${MIGRATE_COMMAND}`,
    { ledger, files: migrationNames.length, missing },
  );
}
