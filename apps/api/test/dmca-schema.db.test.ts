// SPDX-License-Identifier: MIT OR Apache-2.0
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * dmca_notices, dmca_counter_notices and the moderation_actions / outbox changes
 * (migration 0040, ROADMAP R9). Every refusal has a control: the same statement
 * with a valid value succeeds. Rows use fresh random identifiers and are removed
 * afterwards (moderation_actions is append-only, so the action rows are written in
 * a transaction that is rolled back).
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
const userIds: string[] = [];
const noticeIds: string[] = [];

async function newPost(): Promise<string> {
  const uid = randomUUID();
  await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')", [uid, `${uid}@dmca-schema.test`]);
  userIds.push(uid);
  await client.query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [uid, `d${uid.replace(/-/g, "").slice(0, 20)}`]);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO posts (author_id, slug, title, markdown_source, status, published_at)
     VALUES ($1, $2, 'A title', 'body', 'published', now()) RETURNING id`,
    [uid, `s-${randomUUID()}`],
  );
  return rows[0]!.id;
}

const VALID: Record<string, unknown> = {
  complainant_email: "owner@example.test",
  complainant_name: "Jane Owner",
  complainant_address: "1 Example Street",
  complainant_phone: "+1 555 0100",
  signature: "Jane Owner",
  work_description: "My essay",
  statement_good_faith: true,
  statement_accuracy: true,
  target_kind: "post",
  target_label: "A title",
};

async function insertNotice(over: Record<string, unknown> = {}, postId: string | null = null): Promise<string> {
  const row: Record<string, unknown> = { ...VALID, verify_token_hash: randomUUID(), post_id: postId, ...over };
  const names = Object.keys(row);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO dmca_notices (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    names.map((n) => row[n]),
  );
  noticeIds.push(rows[0]!.id);
  return rows[0]!.id;
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.query("DELETE FROM dmca_notices WHERE id = ANY($1::uuid[])", [noticeIds]);
  await client.query("DELETE FROM posts WHERE author_id = ANY($1::uuid[])", [userIds]);
  await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await client.end();
});

describe("dmca_notices", () => {
  it("accepts a complete notice, defaulting to state pending and unconfirmed", async () => {
    const postId = await newPost();
    const id = await insertNotice({}, postId);
    const { rows } = await client.query("SELECT state, email_verified_at FROM dmca_notices WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ state: "pending", email_verified_at: null });
  });

  it.each([
    ["statement_good_faith", false],
    ["statement_accuracy", false],
    ["state", "decided"],
    ["target_kind", "media"],
    ["signature", "   "],
    ["complainant_phone", "x".repeat(51)],
  ])("refuses %s = %j", async (column, value) => {
    await expect(insertNotice({ [column]: value }, await newPost())).rejects.toThrow();
  });

  it("refuses a comment-kind notice that also names a post (one target)", async () => {
    await expect(insertNotice({ target_kind: "comment" }, await newPost())).rejects.toThrow();
  });

  it("sets post_id to NULL when the post is deleted, keeping the notice and its label", async () => {
    const postId = await newPost();
    const id = await insertNotice({}, postId);
    await client.query("DELETE FROM posts WHERE id = $1", [postId]);
    const { rows } = await client.query("SELECT post_id, target_label FROM dmca_notices WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ post_id: null, target_label: "A title" });
  });
});

describe("dmca_counter_notices", () => {
  it("is one per notice, requires both statements, and goes with its notice", async () => {
    const id = await insertNotice({}, await newPost());
    const counter = (over: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = {
        notice_id: id, author_name: "A. Author", author_address: "2 Example Road", author_phone: "+1 555 0101",
        signature: "A. Author", statement_mistake: true, consent_jurisdiction: true, ...over,
      };
      const names = Object.keys(row);
      return client.query(
        `INSERT INTO dmca_counter_notices (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
        names.map((n) => row[n]),
      );
    };
    await expect(counter({ statement_mistake: false })).rejects.toThrow();
    await expect(counter({ consent_jurisdiction: false })).rejects.toThrow();
    await counter();
    await expect(counter()).rejects.toThrow();
    await client.query("DELETE FROM dmca_notices WHERE id = $1", [id]);
    const { rowCount } = await client.query("SELECT 1 FROM dmca_counter_notices WHERE notice_id = $1", [id]);
    expect(rowCount).toBe(0);
  });
});

describe("moderation_actions.dmca_notice_id", () => {
  async function insertAction(over: Record<string, unknown>): Promise<void> {
    const row: Record<string, unknown> = { actor_admin: "tester@example.test", action: "content_remove", reason: "r", ...over };
    const names = Object.keys(row);
    await client.query(
      `INSERT INTO moderation_actions (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => row[n]),
    );
  }

  it("needs source 'dmca_notice'; that source is accepted", async () => {
    await client.query("BEGIN");
    try {
      const noticeId = randomUUID();
      await client.query("SAVEPOINT a");
      await expect(insertAction({ dmca_notice_id: noticeId })).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT a");
      await client.query("SAVEPOINT b");
      await expect(insertAction({ dmca_notice_id: noticeId, source: "dsa_notice" })).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT b");
      await insertAction({ dmca_notice_id: noticeId, source: "dmca_notice" });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

describe("moderation_notice_outbox kinds", () => {
  it("accepts the two DMCA kinds and still refuses an unknown one", async () => {
    await client.query("BEGIN");
    try {
      const insert = (kind: string) =>
        client.query(
          `INSERT INTO moderation_notice_outbox (action_id, kind, recipient_email, subject, body_text, body_html, retain_until)
           VALUES ($1, $2, 'x@example.test', 's', 't', 'h', now() + interval '1 day')`,
          [randomUUID(), kind],
        );
      await insert("dmca_author_notice");
      await insert("dmca_claimant_notice");
      await client.query("SAVEPOINT s");
      await expect(insert("something_else")).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT s");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
