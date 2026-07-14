import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";

/**
 * Vitest **globalSetup** — runs ONCE in Node, before any test project starts.
 *
 * Applies the `apps/api/migrations` SQL migrations to the test database via
 * node-pg-migrate's programmatic runner. node-pg-migrate records applied
 * migrations in the `pgmigrations` table, so re-running `up` is idempotent —
 * the schema is guaranteed present without duplicating work.
 *
 * Reusable by Task 6: pool tests that reach the same test DB through a
 * Hyperdrive binding can rely on the schema already being applied here (this is
 * wired at the ROOT of vitest.config.ts so it covers every project, not just
 * the Node one).
 */

/** localhost default so `pnpm --filter @thinkersjournal/api test` just works. */
const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

/** Absolute path to apps/api/migrations, independent of the process cwd. */
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

export async function setup(): Promise<void> {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  // Expose the resolved URL to test files (they connect with `pg` directly).
  process.env.TEST_DATABASE_URL = databaseUrl;

  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    count: Infinity,
  });
}
