import { Client } from "pg";
import { expect, it } from "vitest";

/**
 * Pins the SERVER MAJOR VERSION, because two things in this repo silently
 * depend on it and neither fails loudly on PG16:
 *   1. migrations/0002 defaults posts.id/media.id to `uuidv7()`, which does
 *      not exist before 18 (`CREATE TABLE` fails outright — loud);
 *   2. Neon has NO in-place major upgrade, so a local/prod major skew is not
 *      a config drift you fix later, it is a data migration.
 * Asserting the major here means a developer on a stale container learns it
 * from one named failure instead of from a confusing migration error.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

async function query<T>(sql: string): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(sql);
    return rows[0] as T;
  } finally {
    await client.end();
  }
}

it("runs on Postgres 18 or newer", async () => {
  const { major } = await query<{ major: number }>(
    "SELECT (current_setting('server_version_num')::int / 10000) AS major",
  );
  expect(
    major,
    "the local container is not Postgres 18+. Run `docker compose down -v && docker compose up -d` — note `-v`, the PG16 data directory is NOT readable by PG18 and there is no in-place upgrade.",
  ).toBeGreaterThanOrEqual(18);
});

it("provides the native uuidv7() function", async () => {
  // NOT `pg_uuidv7`'s uuid_generate_v7() — the NATIVE builtin. See the task
  // header for why the extension was rejected.
  const { v } = await query<{ v: string }>("SELECT uuidv7()::text AS v");
  // Version nibble: char 15 (1-indexed) of the canonical form is the version.
  expect(v[14]).toBe("7");
});

it("still provides gen_random_uuid() for the v4 tables", async () => {
  // users/profiles keep v4 PKs (Global Constraints). Prove 18 did not move it.
  const { v } = await query<{ v: string }>("SELECT gen_random_uuid()::text AS v");
  expect(v[14]).toBe("4");
});
