// SPDX-License-Identifier: MIT OR Apache-2.0
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

const INSERT = `INSERT INTO moderation_notice_outbox (action_id, kind, subject, body_text, body_html, retain_until)
                VALUES ($1, $2, 's', 't', '<p>t</p>', now())`;

describe("moderation_notice_outbox (0034)", () => {
  it("has the designed columns, defaults, nullability and no foreign keys", async () => {
    const { rows } = await client.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'moderation_notice_outbox'`,
    );
    const by = new Map(rows.map((r) => [r.column_name, r]));
    expect(by.size, "control: the table exists").toBeGreaterThan(0);
    for (const col of ["id", "action_id", "kind", "subject", "body_text", "body_html", "state", "attempts", "next_attempt_at", "created_at", "retain_until"]) {
      expect(by.get(col)?.is_nullable, col).toBe("NO");
    }
    for (const col of ["recipient_user_id", "recipient_email", "leased_until", "leased_by", "delivered_at", "last_error"]) {
      expect(by.get(col)?.is_nullable, col).toBe("YES");
    }
    expect(by.get("state")?.column_default).toContain("pending");
    expect(by.get("attempts")?.column_default).toBe("0");
    const fk = await client.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'moderation_notice_outbox' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(fk.rowCount).toBe(0);
  });

  it("refuses a duplicate (action_id, kind) but allows another kind for the same action", async () => {
    const id = "00000000-0000-4000-8000-0000000000b1";
    try {
      await client.query(INSERT, [id, "author_decision"]);
      // Control: a different kind on the SAME action is accepted, so the
      // refusal below is the unique constraint and not a blanket failure.
      await client.query(INSERT, [id, "account_action"]);
      await expect(client.query(INSERT, [id, "author_decision"])).rejects.toThrow(/moderation_notice_outbox_action_kind_key/);
    } finally {
      await client.query("DELETE FROM moderation_notice_outbox WHERE action_id = $1", [id]);
    }
  });

  it("0036: a reporter row is unique per (action_id, kind, dsa_notice_id), and a null notice id keeps the old rule", async () => {
    const id = "00000000-0000-4000-8000-0000000000b4";
    const n1 = "00000000-0000-4000-8000-0000000000c1";
    const n2 = "00000000-0000-4000-8000-0000000000c2";
    const reporter = `INSERT INTO moderation_notice_outbox (action_id, kind, dsa_notice_id, recipient_email, subject, body_text, body_html, retain_until)
                      VALUES ($1, 'reporter_outcome', $2, 'r@example.test', 's', 't', '<p>t</p>', now())`;
    try {
      await client.query(reporter, [id, n1]);
      // Control: a SECOND notice on the same action and kind is accepted, so the refusal below is the index.
      await client.query(reporter, [id, n2]);
      await expect(client.query(reporter, [id, n1])).rejects.toThrow(/moderation_notice_outbox_action_kind_notice_key/);
      // A bare ON CONFLICT DO NOTHING absorbs the duplicate.
      const r = await client.query(`${reporter} ON CONFLICT DO NOTHING`, [id, n1]);
      expect(r.rowCount).toBe(0);
      // A row with no notice id is still one per (action, kind).
      await client.query(INSERT, [id, "appeal_outcome"]);
      await expect(client.query(INSERT, [id, "appeal_outcome"])).rejects.toThrow(/moderation_notice_outbox_action_kind_key/);
    } finally {
      await client.query("DELETE FROM moderation_notice_outbox WHERE action_id = $1", [id]);
    }
  });

  it("accepts all five kinds and refuses an unknown one", async () => {
    const id = "00000000-0000-4000-8000-0000000000b2";
    try {
      for (const kind of ["author_decision", "author_auto_hide", "account_action", "appeal_outcome", "reporter_outcome"]) {
        await client.query(INSERT, [id, kind]);
      }
      await expect(client.query(INSERT, [id, "author"])).rejects.toThrow(/moderation_notice_outbox_kind_valid/);
    } finally {
      await client.query("DELETE FROM moderation_notice_outbox WHERE action_id = $1", [id]);
    }
  });

  it("refuses a state outside pending|sending|delivered|undeliverable", async () => {
    const id = "00000000-0000-4000-8000-0000000000b3";
    try {
      // Control: a valid state is accepted.
      await client.query(
        `INSERT INTO moderation_notice_outbox (action_id, kind, subject, body_text, body_html, retain_until, state)
         VALUES ($1, 'author_decision', 's', 't', '<p>t</p>', now(), 'undeliverable')`,
        [id],
      );
      await expect(
        client.query(`UPDATE moderation_notice_outbox SET state = 'sent' WHERE action_id = $1`, [id]),
      ).rejects.toThrow(/moderation_notice_outbox_state_valid/);
    } finally {
      await client.query("DELETE FROM moderation_notice_outbox WHERE action_id = $1", [id]);
    }
  });
});
