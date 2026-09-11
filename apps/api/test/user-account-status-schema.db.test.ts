import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0015 — the SHAPE of the three account-status columns.
 *
 * Scope is deliberately narrow: this file asks `information_schema` what the
 * migration produced. It does NOT test the reaper. The reaper's AC-3 guard is
 * pinned in test/reap-unverified.test.ts, which drives the real
 * `reapUnverifiedAccounts` — a predicate re-typed into a test file proves
 * only that the test file's own string works.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});
afterAll(async () => { await client.end(); });

describe("users account status (0015)", () => {
  it("adds three nullable columns", async () => {
    const { rows } = await client.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='users'
          AND column_name IN ('suspended_until','disabled_at','disabled_reason')`,
    );
    expect(rows).toHaveLength(3);
    // Nullable is the point: NULL is "not barred", and it must be the state of
    // every account that already exists when this migration runs.
    for (const r of rows) expect(r.is_nullable, `${r.column_name}`).toBe("YES");
    const byName = new Map(rows.map((r) => [r.column_name, r.data_type]));
    expect(byName.get("suspended_until")).toBe("timestamp with time zone");
    expect(byName.get("disabled_at")).toBe("timestamp with time zone");
    expect(byName.get("disabled_reason")).toBe("text");
  });
});
