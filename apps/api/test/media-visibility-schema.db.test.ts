import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0016 (#61) — the SHAPE the visibility/legal-hold machinery reads
 * and writes. Scope is deliberately narrow: this asks `information_schema`
 * and `pg_constraint` what the migration produced. Behaviour is pinned by
 * test/admin-decision-route.test.ts's "#61 media visibility" block and
 * test/media-restricted-route.test.ts.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

describe("media visibility tables (0016)", () => {
  it("media_legal_holds is keyed on r2_key, not a post", async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'media_legal_holds'::regclass AND i.indisprimary`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["r2_key"]);
  });

  it("media_moves rejects an unknown direction", async () => {
    await expect(
      client.query(`INSERT INTO media_moves (r2_key, direction) VALUES ('x', 'sideways')`),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("media_access_requests has no unique constraint forcing one request per key", async () => {
    // Deliberately NOT unique on r2_key: more than one admin may legitimately
    // request access to the same held object over time.
    const { rows } = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'media_access_requests'::regclass AND contype = 'u'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("moderation_actions accepts 'media_access' (widened CHECK)", async () => {
    await client.query("BEGIN");
    try {
      await expect(
        client.query(
          `INSERT INTO moderation_actions (actor_admin, action, reason) VALUES ('test@example.com', 'media_access', 'r')`,
        ),
      ).resolves.toBeDefined();
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("moderation_actions still rejects an unknown action", async () => {
    await expect(
      client.query(
        `INSERT INTO moderation_actions (actor_admin, action, reason) VALUES ('test@example.com', 'nonsense', 'r')`,
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("media_access_requests refuses a same-row self-approval AT THE DB LEVEL, case-insensitively (PM review)", async () => {
    await expect(
      client.query(
        `INSERT INTO media_access_requests (r2_key, requested_by, reason, approved_by, approved_at, expires_at)
         VALUES ('x', 'Alice@Example.Test', 'r', 'alice@example.test', now(), now() + interval '15 minutes')`,
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("media_backfill_progress is a singleton, seeded by the migration", async () => {
    const { rows } = await client.query<{ count: string }>(`SELECT count(*)::int AS count FROM media_backfill_progress`);
    expect(Number(rows[0]!.count)).toBe(1);
    await expect(
      client.query(`INSERT INTO media_backfill_progress (id) VALUES (true)`),
    ).rejects.toThrow(/duplicate key/);
  });
});
