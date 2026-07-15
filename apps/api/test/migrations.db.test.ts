import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

// Runs in the Node vitest project (environment: 'node') with a direct pg TCP
// connection — NOT in workerd. The schema is applied by the root globalSetup
// (test/global-setup.ts) before this file runs.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

async function migrate(direction: "up" | "down"): Promise<void> {
  await runner({
    databaseUrl: TEST_DATABASE_URL,
    dir: migrationsDir,
    direction,
    migrationsTable: "pgmigrations",
    count: direction === "down" ? 1 : Infinity,
  });
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
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

  it("down drops both tables and up restores them (round-trip); leaves DB migrated", async () => {
    await withClient(async (client) => {
      expect(await tableExists(client, "users")).toBe(true);
      expect(await tableExists(client, "profiles")).toBe(true);
    });

    await migrate("down");
    await withClient(async (client) => {
      expect(await tableExists(client, "users")).toBe(false);
      expect(await tableExists(client, "profiles")).toBe(false);
    });

    await migrate("up");
    await withClient(async (client) => {
      expect(await tableExists(client, "users")).toBe(true);
      expect(await tableExists(client, "profiles")).toBe(true);
    });
    // Intentionally left in the migrated (up) state so Task 6 can reuse the DB.
  });
});
