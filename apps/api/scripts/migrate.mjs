// Windows-safe migration CLI wrapper.
//
// pnpm/npm scripts run under cmd.exe on Windows, where `$DATABASE_URL` does NOT
// expand — so we never rely on shell variable expansion. Instead we resolve the
// connection string here in Node (from process.env with localhost defaults) and
// drive node-pg-migrate's programmatic `runner`. This runs identically on
// Windows, macOS, and Linux.
//
// Usage:
//   node scripts/migrate.mjs [dev|test] [up|down] [count]
//   (defaults: target=dev, direction=up, count=Infinity for up / 1 for down)
//
// `count` (#116 fix round 1, item 4) — an optional positive integer capping
// how many pending migrations `up` applies, e.g. `node scripts/migrate.mjs
// dev up 1` applies exactly the next one and stops. This is how the deploy
// runbook (docs/runbooks/deploy.md) applies migrations one at a time up to,
// but never past, one marked `-- deploy: after-code`: node-pg-migrate's own
// `up` has no "stop before this named migration" option, only "apply at most
// N pending ones", so the runbook counts how many come before the after-code
// one and passes that number here.
import { fileURLToPath, pathToFileURL } from "node:url";
import { runner } from "node-pg-migrate";

/**
 * Pure: parses `process.argv.slice(2)` into `{ target, direction, count }`.
 * Extracted so this is testable without a database connection (#116 fix round
 * 1, item 4) — `main()` below is the only thing that touches `node-pg-migrate`
 * or a real `databaseUrl`, and NEVER runs under test.
 *
 * Throws a plain `Error` (never calls `process.exit` itself) for an invalid
 * `count`, so a caller — here, `main()` — decides how to report it.
 */
export function parseArgs(argv) {
  const target = argv[0] ?? "dev"; // "dev" | "test"
  const direction = argv[1] ?? "up"; // "up" | "down"
  const countArg = argv[2];

  // `up` applies all pending migrations by default; `down` reverts one at a
  // time. An explicit `countArg` overrides either default, regardless of
  // direction.
  let count = direction === "down" ? 1 : Infinity;
  if (countArg !== undefined) {
    const parsed = Number(countArg);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `count must be a positive integer, got "${countArg}" — e.g. ` +
          `\`node scripts/migrate.mjs dev up 1\` to apply exactly one pending migration.`,
      );
    }
    count = parsed;
  }

  return { target, direction, count };
}

const DEFAULT_URLS = {
  dev: "postgres://postgres:postgres@localhost:5432/thinkersjournal",
  test: "postgres://postgres:postgres@localhost:5432/thinkersjournal_test",
};

/**
 * Runs the real migration. NEVER called by importing this module (only by
 * the guarded entry point below) — this is what actually opens a database
 * connection and applies migrations, so a test importing `parseArgs` must
 * never reach it.
 */
async function main() {
  const { target, direction, count } = parseArgs(process.argv.slice(2));

  const databaseUrl =
    target === "test"
      ? (process.env.TEST_DATABASE_URL ?? DEFAULT_URLS.test)
      : (process.env.DATABASE_URL ?? DEFAULT_URLS.dev);

  // Absolute path to apps/api/migrations, independent of the process cwd.
  const dir = fileURLToPath(new URL("../migrations", import.meta.url));

  await runner({
    databaseUrl,
    dir,
    direction,
    migrationsTable: "pgmigrations",
    count,
  });
}

// Guarded the same way as scripts/check-migrations-applied.mjs (#116 fix
// round 1, item 1's pattern, applied here too): `main()` — which opens a REAL
// database connection and can apply REAL migrations — runs ONLY when this
// file is executed directly, never when `parseArgs` is imported for testing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
