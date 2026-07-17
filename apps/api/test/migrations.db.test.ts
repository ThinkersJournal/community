import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

// Runs in the Node vitest project (environment: 'node') with a direct pg TCP
// connection — NOT in workerd.
//
// ⚠️ THIS FILE HAS ITS OWN DATABASE, AND THAT IS LOAD-BEARING.
// It proves the migration SQL by RUNNING it: `down` drops every table in the
// stack (media, posts, profiles, users), then `up` recreates them. On the
// shared fixture DB that is a race, not a test: vitest runs test PROJECTS in
// parallel unless `sequence.groupOrder` says otherwise, so the "pool" project's
// Worker tests (signup/login/logout/email-verify/epoch-revoke/soft-gate/
// hyperdrive — all reaching the SAME database through Hyperdrive) can be
// mid-query in the window where this file has `users` dropped, and fail with
// `relation "users" does not exist`. This file needs *a* database, not the
// shared one, so it gets its own: the hazard is then structurally impossible
// rather than a scheduling constraint a future edit can quietly drop.
//
// The database is created by db/init/01-create-test-db.sql (fresh volumes) and,
// for volumes that predate it, by test/global-setup.ts. Its SCHEMA state is
// owned HERE (globalSetup migrates only the shared DB) — hence the beforeAll.
const MIGRATIONS_TEST_DATABASE_URL =
  process.env.MIGRATIONS_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_migrations_test";

/** The SHARED fixture DB — read-only here, only to prove we never touch it. */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

async function migrate(direction: "up" | "down"): Promise<void> {
  await runner({
    databaseUrl: MIGRATIONS_TEST_DATABASE_URL,
    dir: migrationsDir,
    direction,
    migrationsTable: "pgmigrations",
    // Infinity in BOTH directions: "down" must revert the ENTIRE applied
    // stack, not just the most-recently-applied file. With count: 1, adding
    // migrations/0002 on top of 0001 made "down" revert 0002 ONLY (posts +
    // media), leaving users/profiles in place — this test would then assert
    // those tables are gone and fail. Reverting the whole stack keeps this
    // round-trip test correct regardless of how many migrations exist.
    count: Infinity,
  });
}

async function withClient<T>(
  fn: (client: Client) => Promise<T>,
  connectionString: string = MIGRATIONS_TEST_DATABASE_URL,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function tableExists(client: Client, table: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows.length === 1;
}

// globalSetup migrates the SHARED DB; this one is ours to set up. Idempotent
// (node-pg-migrate's `pgmigrations` table), so this is a no-op after run 1.
beforeAll(async () => {
  await migrate("up");
});

describe("0001 users + profiles migration", () => {
  it("creates users with password_hash, email_verified_at (nullable), and citext email", async () => {
    await withClient(async (client) => {
      const { rows } = await client.query(
        `SELECT column_name, data_type, udt_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users'`,
      );
      const byName = new Map<string, (typeof rows)[number]>(
        rows.map((r) => [r.column_name, r]),
      );

      expect(byName.has("password_hash")).toBe(true);
      expect(byName.get("password_hash")?.data_type).toBe("text");

      expect(byName.has("email_verified_at")).toBe(true);
      expect(byName.get("email_verified_at")?.data_type).toBe(
        "timestamp with time zone",
      );
      expect(byName.get("email_verified_at")?.is_nullable).toBe("YES");

      // citext surfaces in information_schema as USER-DEFINED / udt_name 'citext'.
      expect(byName.get("email")?.udt_name).toBe("citext");
    });
  });

  it("profiles.user_id exists and is a FK to users.id", async () => {
    await withClient(async (client) => {
      const { rows: cols } = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'profiles'
            AND column_name = 'user_id'`,
      );
      expect(cols).toHaveLength(1);

      const { rows: fks } = await client.query(
        `SELECT kcu.column_name AS fk_column,
                ccu.table_name  AS ref_table,
                ccu.column_name AS ref_column
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema    = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name
            AND tc.table_schema    = ccu.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema    = 'public'
            AND tc.table_name      = 'profiles'`,
      );

      expect(fks).toEqual([
        { fk_column: "user_id", ref_table: "users", ref_column: "id" },
      ]);
    });
  });

  it("down drops every table and up restores them (round-trip); leaves DB migrated", async () => {
    await withClient(async (client) => {
      expect(await tableExists(client, "users")).toBe(true);
      expect(await tableExists(client, "profiles")).toBe(true);
      expect(await tableExists(client, "posts")).toBe(true);
      expect(await tableExists(client, "media")).toBe(true);
    });

    await migrate("down");
    await withClient(async (client) => {
      expect(await tableExists(client, "users")).toBe(false);
      expect(await tableExists(client, "profiles")).toBe(false);
      expect(await tableExists(client, "posts")).toBe(false);
      expect(await tableExists(client, "media")).toBe(false);
    });

    // THE ISOLATION PROPERTY, pinned. The stack is torn down above — in OUR
    // database. If this file ever gets pointed back at the shared fixture DB,
    // this assertion fails HERE, loudly and deterministically, instead of
    // surfacing as an intermittent `relation "users" does not exist` in an
    // unrelated pool test that happened to query during the drop window.
    await withClient(async (client) => {
      expect(
        await tableExists(client, "users"),
        "the destructive migration round-trip reached the SHARED test DB. It must run against MIGRATIONS_TEST_DATABASE_URL (its own database) — the pool project's Worker tests query the shared DB through Hyperdrive CONCURRENTLY with this project.",
      ).toBe(true);
    }, TEST_DATABASE_URL);

    await migrate("up");
    await withClient(async (client) => {
      expect(await tableExists(client, "users")).toBe(true);
      expect(await tableExists(client, "profiles")).toBe(true);
      expect(await tableExists(client, "posts")).toBe(true);
      expect(await tableExists(client, "media")).toBe(true);
    });
    // Intentionally left in the migrated (up) state.
  });
});
