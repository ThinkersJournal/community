import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

describe("moderation_notice_records (0032)", () => {
  it("has retain_until NOT NULL, no recipient column, and no foreign keys", async () => {
    const { rows } = await client.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'moderation_notice_records'`,
    );
    const by = new Map(rows.map((r) => [r.column_name, r.is_nullable]));
    expect(by.size, "control: the table exists").toBeGreaterThan(0);
    expect(by.get("retain_until")).toBe("NO");
    expect(by.get("body_text")).toBe("NO");
    expect([...by.keys()].filter((k) => /email|recipient|user/i.test(k))).toEqual([]);
    const fk = await client.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'moderation_notice_records' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(fk.rowCount).toBe(0);
  });

  it("rejects an unknown kind and a duplicate action_id", async () => {
    const id = "00000000-0000-4000-8000-0000000000aa";
    await expect(
      client.query(
        `INSERT INTO moderation_notice_records (action_id, kind, subject, body_text, retain_until)
         VALUES ($1, 'reporter', 's', 't', now())`,
        [id],
      ),
    ).rejects.toThrow(/kind_valid/);
    await client.query(
      `INSERT INTO moderation_notice_records (action_id, kind, subject, body_text, retain_until)
       VALUES ($1, 'author', 's', 't', now())`,
      [id],
    );
    try {
      await expect(
        client.query(
          `INSERT INTO moderation_notice_records (action_id, kind, subject, body_text, retain_until)
           VALUES ($1, 'account', 's', 't', now())`,
          [id],
        ),
      ).rejects.toThrow(/duplicate key/);
    } finally {
      await client.query("DELETE FROM moderation_notice_records WHERE action_id = $1", [id]);
    }
  });
});
