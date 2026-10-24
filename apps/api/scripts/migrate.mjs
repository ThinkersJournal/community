// SPDX-License-Identifier: MIT OR Apache-2.0
// Windows-safe migration CLI wrapper.
//
// pnpm/npm scripts run under cmd.exe on Windows, where `$DATABASE_URL` does NOT
// expand — so we never rely on shell variable expansion. Instead we resolve the
// connection string here in Node (from process.env) and drive node-pg-migrate's
// programmatic `runner`. This runs identically on Windows, macOS, and Linux.
//
// Usage:
//   node scripts/migrate.mjs [dev|test] [up|down] [count] [--local] [--allow-remote]
//   (defaults: target=dev, direction=up, count=Infinity for up / 1 for down)
//
// ⚠️ TARGET SAFETY (2026-10-17 incident: a production URL held under another
// variable name silently migrated the LOCAL dev database). The rules live in
// `scripts/lib/migrate-args.mjs` (`resolveTarget`) and are unit-tested:
//   - the target host, port and database are PRINTED before anything connects;
//   - the dev target REQUIRES `DATABASE_URL`; with it unset the script refuses,
//     unless `--local` says the localhost default is what you meant
//     (`pnpm migrate` passes it);
//   - a host that is not localhost is refused unless `--allow-remote`
//     (the production runbook's commands pass it).
//
// `count` (#116 fix round 1, item 4) — an optional positive integer capping
// how many pending migrations `up` applies, e.g. `node scripts/migrate.mjs
// dev up 1` applies exactly the next one and stops. This is how the deploy
// runbook (docs/runbooks/deploy.md) applies migrations one at a time up to,
// but never past, one marked `-- deploy: after-code`: node-pg-migrate's own
// `up` has no "stop before this named migration" option, only "apply at most
// N pending ones", so the runbook counts how many come before the after-code
// one and passes that number here.
//
// ⚠️ UNCONDITIONAL TOP-LEVEL EXECUTION — NO ENTRY-POINT GUARD (#116 fix round
// 2 ruling: the same fail-open risk as scripts/check-migrations-applied.mjs —
// see scripts/lib/migration-gate.mjs's header for the full story). Here it
// would mean the PM's "apply the migration" run silently does nothing and
// reports nothing. All logic, including every refusal, lives in
// `scripts/lib/migrate-args.mjs` (no side effects), which THROWS; this file
// has no conditional and runs exactly one path.
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";

import { resolveTarget } from "./lib/migrate-args.mjs";

const { direction, count, databaseUrl, banner } = resolveTarget(process.argv.slice(2), process.env);

console.log(banner);

// Absolute path to apps/api/migrations, independent of the process cwd.
const dir = fileURLToPath(new URL("../migrations", import.meta.url));

await runner({
  databaseUrl,
  dir,
  direction,
  migrationsTable: "pgmigrations",
  count,
});
