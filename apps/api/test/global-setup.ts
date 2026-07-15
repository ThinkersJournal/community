import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import { Client } from "pg";

/**
 * Vitest **globalSetup** — runs ONCE in Node, before any test project starts.
 *
 * Applies the `apps/api/migrations` SQL migrations to the SHARED test database
 * via node-pg-migrate's programmatic runner. node-pg-migrate records applied
 * migrations in the `pgmigrations` table, so re-running `up` is idempotent —
 * the schema is guaranteed present without duplicating work.
 *
 * Reusable by Task 6: pool tests that reach the same test DB through a
 * Hyperdrive binding can rely on the schema already being applied here (this is
 * wired at the ROOT of vitest.config.ts so it covers every project, not just
 * the Node one).
 *
 * It does NOT migrate the migrations-test DB (see below): that database belongs
 * to test/migrations.db.test.ts, which drops and recreates the whole stack and
 * therefore owns its own schema state. This only guarantees the database
 * EXISTS, which needs a maintenance connection a test file should not be making.
 */

/** localhost defaults so `pnpm --filter @thinkersjournal/api test` just works. */
const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";
const DEFAULT_MIGRATIONS_TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_migrations_test";

/** Absolute path to apps/api/migrations, independent of the process cwd. */
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * `CREATE DATABASE` if it is not already there, via the `postgres` maintenance
 * DB (Postgres has no `CREATE DATABASE IF NOT EXISTS`).
 *
 * db/init/01-create-test-db.sql already creates this database — but ONLY on the
 * first boot of an empty data directory. Every checkout whose volume predates
 * that file (i.e. every existing one) would otherwise fail with `database
 * "thinkersjournal_migrations_test" does not exist` and be told to
 * `docker compose down -v`, wiping their dev data to run a test suite. Creating
 * it here makes the split work on an existing volume with no manual step.
 */
async function ensureDatabase(databaseUrl: string): Promise<void> {
  const { pathname, href } = new URL(databaseUrl);
  const name = pathname.slice(1);
  const admin = new Client({
    connectionString: new URL("/postgres", href).toString(),
  });
  await admin.connect();
  try {
    const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      name,
    ]);
    if (rows.length === 0) {
      // Not parameterizable (an identifier, not a value) and CREATE DATABASE
      // cannot run inside a transaction. `name` is derived from our own
      // constant/env var, never from test input.
      await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }
}

export async function setup(): Promise<void> {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const migrationsDatabaseUrl =
    process.env.MIGRATIONS_TEST_DATABASE_URL ??
    DEFAULT_MIGRATIONS_TEST_DATABASE_URL;
  // Expose the resolved URLs to test files (they connect with `pg` directly).
  process.env.TEST_DATABASE_URL = databaseUrl;
  process.env.MIGRATIONS_TEST_DATABASE_URL = migrationsDatabaseUrl;

  await ensureDatabase(migrationsDatabaseUrl);

  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    count: Infinity,
  });
}
