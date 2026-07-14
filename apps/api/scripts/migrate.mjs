// Windows-safe migration CLI wrapper.
//
// pnpm/npm scripts run under cmd.exe on Windows, where `$DATABASE_URL` does NOT
// expand — so we never rely on shell variable expansion. Instead we resolve the
// connection string here in Node (from process.env with localhost defaults) and
// drive node-pg-migrate's programmatic `runner`. This runs identically on
// Windows, macOS, and Linux.
//
// Usage:
//   node scripts/migrate.mjs [dev|test] [up|down]
//   (defaults: target=dev, direction=up)
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";

const target = process.argv[2] ?? "dev"; // "dev" | "test"
const direction = process.argv[3] ?? "up"; // "up" | "down"

const DEFAULT_URLS = {
  dev: "postgres://postgres:postgres@localhost:5432/thinkersjournal",
  test: "postgres://postgres:postgres@localhost:5432/thinkersjournal_test",
};

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
  // `up` applies all pending migrations; `down` reverts one at a time.
  count: direction === "down" ? 1 : Infinity,
});
