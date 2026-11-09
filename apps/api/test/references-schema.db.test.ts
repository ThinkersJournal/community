// SPDX-License-Identifier: MIT OR Apache-2.0
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * "references" and post_references (migration 0042, M3.1b; spec 4). Every refusal has a control: the same statement
 * with a valid value succeeds. Each test names the mutation (a change to the migration) that must turn it red.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
const userIds: string[] = [];
const referenceIds: string[] = [];

async function newPost(): Promise<string> {
  const uid = randomUUID();
  await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')", [uid, `${uid}@refs-schema.test`]);
  userIds.push(uid);
  await client.query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [uid, `r${uid.replace(/-/g, "").slice(0, 20)}`]);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO posts (author_id, slug, title, markdown_source, status, published_at)
     VALUES ($1, $2, 'A title', 'body', 'published', now()) RETURNING id`,
    [uid, `s-${randomUUID()}`],
  );
  return rows[0]!.id;
}

async function newReference(over: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    kind: "web",
    resource_key: `web:https://example.com/${randomUUID()}`,
    content_hash: "a".repeat(64),
    snapshot: JSON.stringify({ kind: "web", title: "t", finalUrl: "https://example.com/" }),
    ...over,
  };
  const names = Object.keys(row);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO "references" (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    names.map((n) => row[n]),
  );
  referenceIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function attach(postId: string, referenceId: string, token: string): Promise<void> {
  await client.query("INSERT INTO post_references (post_id, reference_id, token) VALUES ($1, $2, $3)", [postId, referenceId, token]);
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.query("DELETE FROM posts WHERE author_id = ANY($1::uuid[])", [userIds]);
  await client.query(`DELETE FROM "references" WHERE id = ANY($1::uuid[])`, [referenceIds]);
  await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await client.end();
});

describe('"references"', () => {
  it("accepts a valid row and fills the defaults (a uuidv7 id, public, retention none, dormant, timestamps)", async () => {
    const id = await newReference();
    const { rows } = await client.query(
      `SELECT visibility, retention_policy, owner_connection_id, last_viewed_at, next_check_at, gone_at, live_state,
              created_at IS NOT NULL AS has_created, updated_at IS NOT NULL AS has_updated, substr(id::text, 15, 1) AS ver
         FROM "references" WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({
      visibility: "public",
      retention_policy: "none",
      owner_connection_id: null,
      last_viewed_at: null,
      next_check_at: null,
      gone_at: null,
      live_state: null,
      has_created: true,
      has_updated: true,
      ver: "7",
    });
  });

  // Mutation that must fail: drop the visibility CHECK.
  it("refuses visibility 'private' (public-only at launch, spec 3.4)", async () => {
    await expect(newReference({ visibility: "private" })).rejects.toThrow(/references_visibility|check constraint/i);
    await expect(newReference({ visibility: "public" })).resolves.toBeTruthy(); // control
  });

  // Mutation that must fail: drop the kind CHECK (or add 'youtube' to it).
  it("refuses an unknown kind and accepts web, github and gitlab", async () => {
    await expect(newReference({ kind: "youtube" })).rejects.toThrow(/references_kind|check constraint/i);
    for (const kind of ["web", "github", "gitlab"]) await expect(newReference({ kind })).resolves.toBeTruthy(); // control
  });

  // Mutation that must fail: drop the UNIQUE (kind, resource_key, content_hash).
  it("refuses a second row with the same (kind, resource_key, content_hash); a different hash is a new row", async () => {
    const key = `web:https://example.com/${randomUUID()}`;
    await newReference({ resource_key: key, content_hash: "1".repeat(64) });
    await expect(newReference({ resource_key: key, content_hash: "1".repeat(64) })).rejects.toThrow(/unique|duplicate/i);
    await expect(newReference({ resource_key: key, content_hash: "2".repeat(64) })).resolves.toBeTruthy(); // control
  });

  // Mutation that must fail: add NOT NULL to snapshot (a takedown must be able to null it in place, spec 4).
  it("lets the snapshot be nulled in place", async () => {
    const id = await newReference();
    await client.query(`UPDATE "references" SET snapshot = NULL WHERE id = $1`, [id]);
    const { rows } = await client.query(`SELECT snapshot FROM "references" WHERE id = $1`, [id]);
    expect(rows[0]?.snapshot).toBeNull();
  });
});

describe("post_references", () => {
  it("a valid use is accepted", async () => {
    await expect(attach(await newPost(), await newReference(), "ABCDEFGHIJKL")).resolves.toBeUndefined();
  });

  // Mutation that must fail: drop UNIQUE (post_id, token).
  it("a token is unique per post, and the same token on another post is fine", async () => {
    const [p1, p2, ref] = [await newPost(), await newPost(), await newReference()];
    await attach(p1, ref, "AAAAAAAAAAAA");
    await expect(attach(p1, ref, "AAAAAAAAAAAA")).rejects.toThrow(/unique|duplicate/i);
    await expect(attach(p2, ref, "AAAAAAAAAAAA")).resolves.toBeUndefined(); // control
    await expect(attach(p1, ref, "BBBBBBBBBBBB")).resolves.toBeUndefined(); // control
  });

  // Mutation that must fail: remove ON DELETE CASCADE from post_id.
  it("deleting the post removes its uses and keeps the reference", async () => {
    const [post, ref] = [await newPost(), await newReference()];
    await attach(post, ref, "CCCCCCCCCCCC");
    await client.query("DELETE FROM posts WHERE id = $1", [post]);
    const uses = await client.query("SELECT 1 FROM post_references WHERE post_id = $1", [post]);
    const kept = await client.query(`SELECT 1 FROM "references" WHERE id = $1`, [ref]);
    expect(uses.rowCount).toBe(0);
    expect(kept.rowCount).toBe(1);
  });

  // Mutation that must fail: make reference_id ON DELETE CASCADE (a deleted reference would silently drop a card).
  it("a reference still in use cannot be deleted", async () => {
    const [post, ref] = [await newPost(), await newReference()];
    await attach(post, ref, "DDDDDDDDDDDD");
    await expect(client.query(`DELETE FROM "references" WHERE id = $1`, [ref])).rejects.toThrow(/foreign key|violates/i);
  });

  // Mutation that must fail: drop the token CHECK (12 unpadded base32 characters).
  it.each(["abcdefghijkl", "ABCDEFGHIJK", "ABCDEFGHIJKLM", "ABCDEFGHIJK1", "ABCDEFGH===="])("refuses the malformed token %s", async (token) => {
    await expect(attach(await newPost(), await newReference(), token)).rejects.toThrow(/post_references_token|check constraint/i);
  });
});
