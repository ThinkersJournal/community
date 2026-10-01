import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * #58 Q2 — `moderation_snapshots` (0020). CireSnave: "minimum of 1 year or
 * until a lawyer states it should be removed."
 *
 * A guard never shown to fire is a claim, not a guard: every refusal below has
 * a control that the same statement succeeds when the guard should allow it.
 *
 * ⚠️ Rows written here cannot be cleaned up inside their first year — that is
 * the property under test. They hold random uuids and reference nothing.
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

async function insertSnapshot(capturedAt?: Date): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO moderation_snapshots (post_id, author_id, title, body_markdown, captured_at)
     VALUES ($1, $2, 'snap', 'body', COALESCE($3::timestamptz, now())) RETURNING id`,
    [randomUUID(), randomUUID(), capturedAt ?? null],
  );
  return rows[0]!.id;
}

async function exists(id: string): Promise<boolean> {
  return (await client.query(`SELECT 1 FROM moderation_snapshots WHERE id = $1`, [id])).rowCount === 1;
}

describe("moderation_snapshots — retention floor and immutability (#58 Q2)", () => {
  it("refuses an UPDATE", async () => {
    const id = await insertSnapshot();
    await expect(client.query(`UPDATE moderation_snapshots SET body_markdown = 'x' WHERE id = $1`, [id])).rejects.toThrow(
      /immutable/,
    );
  });

  it("refuses a DELETE of a snapshot younger than one year", async () => {
    const id = await insertSnapshot(new Date(Date.now() - 364 * 24 * 3600 * 1000));
    await expect(client.query(`DELETE FROM moderation_snapshots WHERE id = $1`, [id])).rejects.toThrow(/at least 1 year/);
    expect(await exists(id)).toBe(true);
  });

  it("CONTROL: a DELETE of a snapshot older than one year is possible (a deliberate manual act)", async () => {
    const id = await insertSnapshot(new Date(Date.now() - 366 * 24 * 3600 * 1000));
    await client.query(`DELETE FROM moderation_snapshots WHERE id = $1`, [id]);
    expect(await exists(id)).toBe(false);
  });

  it("refuses a TRUNCATE (statement-level: the row trigger alone would not see it)", async () => {
    await insertSnapshot();
    await expect(client.query(`TRUNCATE moderation_snapshots`)).rejects.toThrow(/cannot be truncated/);
  });

  it("requires exactly one target", async () => {
    await expect(
      client.query(`INSERT INTO moderation_snapshots (author_id, body_markdown) VALUES ($1, 'x')`, [randomUUID()]),
    ).rejects.toThrow(/moderation_snapshots_one_target/);
    await expect(
      client.query(
        `INSERT INTO moderation_snapshots (post_id, comment_id, author_id, body_markdown) VALUES ($1, $2, $3, 'x')`,
        [randomUUID(), randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/moderation_snapshots_one_target/);
  });

  it("has no foreign keys — a snapshot must outlive its post, comment and author", async () => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.table_constraints
        WHERE table_name = 'moderation_snapshots' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(rows[0]!.n).toBe(0);
    // CONTROL: the same query does find FKs on a table that has them.
    const { rows: control } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.table_constraints
        WHERE table_name = 'reports' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(control[0]!.n).toBeGreaterThan(0);
  });
});
