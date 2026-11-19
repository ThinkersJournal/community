// SPDX-License-Identifier: MIT OR Apache-2.0
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
let alice: string;
let bob: string;
let postId: string;

async function makeUser(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`notif-${crypto.randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}
async function makePost(authorId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
     VALUES ($1, 't', $2, 'b', 'published', now()) RETURNING id`,
    [authorId, `s-${crypto.randomUUID()}`],
  );
  return rows[0]!.id;
}
function insertNotif(cols: Record<string, unknown>): Promise<unknown> {
  const keys = Object.keys(cols);
  const vals = keys.map((_, i) => `$${i + 1}`);
  return client.query(
    `INSERT INTO notifications (${keys.join(",")}) VALUES (${vals.join(",")})`,
    Object.values(cols),
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  alice = await makeUser();
  bob = await makeUser();
  postId = await makePost(alice);
});
afterAll(async () => {
  await client.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob]]);
  await client.end();
});

describe("notifications schema", () => {
  it("assigns a uuidv7 id and defaults read_at null", async () => {
    const { rows } = await client.query<{ id: string; read_at: string | null }>(
      `INSERT INTO notifications (recipient_id, actor_id, kind, post_id, comment_id)
       VALUES ($1,$2,'post_comment',$3,NULL) RETURNING id, read_at`,
      [alice, bob, postId],
    );
    expect(rows[0]!.id[14]).toBe("7");
    expect(rows[0]!.read_at).toBeNull();
    await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
  });

  it("rejects a self-notification (CHECK 23514)", async () => {
    await expect(
      insertNotif({ recipient_id: alice, actor_id: alice, kind: "follow" }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an unknown kind (CHECK 23514)", async () => {
    await expect(
      insertNotif({ recipient_id: alice, actor_id: bob, kind: "mention" }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("dedupes on the natural key incl. NULLs (unique 23505)", async () => {
    await insertNotif({ recipient_id: alice, actor_id: bob, kind: "follow" });
    // A second identical event — NULL post/comment/reaction — must collide, which
    // requires NULLS NOT DISTINCT; without it every NULL-bearing row is distinct.
    await expect(
      insertNotif({ recipient_id: alice, actor_id: bob, kind: "follow" }),
    ).rejects.toMatchObject({ code: "23505" });
    // A different reaction_kind on the same post IS a distinct event.
    await insertNotif({ recipient_id: alice, actor_id: bob, kind: "post_reaction", post_id: postId, reaction_kind: "insightful" });
    await insertNotif({ recipient_id: alice, actor_id: bob, kind: "post_reaction", post_id: postId, reaction_kind: "agree" });
    await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
  });

  describe("reference_changed (M3.9, migration 0045)", () => {
    async function makeReference(): Promise<string> {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO "references" (kind, resource_key, content_hash, snapshot)
         VALUES ('web', $1, 'h', '{}'::jsonb) RETURNING id`,
        [`web:https://example.com/${crypto.randomUUID()}`],
      );
      return rows[0]!.id;
    }

    it("accepts a system event: NULL actor, reference_id and reference_event set", async () => {
      const ref = await makeReference();
      await insertNotif({
        recipient_id: alice, actor_id: null, kind: "reference_changed",
        post_id: postId, reference_id: ref, reference_event: "gone",
      });
      await client.query(`DELETE FROM "references" WHERE id=$1`, [ref]);
      await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
    });

    it("rejects a NULL actor on every other kind, and an actor on reference_changed (CHECK 23514)", async () => {
      const ref = await makeReference();
      await expect(insertNotif({ recipient_id: alice, actor_id: null, kind: "follow" })).rejects.toMatchObject({ code: "23514" });
      await expect(
        insertNotif({ recipient_id: alice, actor_id: bob, kind: "reference_changed", post_id: postId, reference_id: ref, reference_event: "gone" }),
      ).rejects.toMatchObject({ code: "23514" });
      await client.query(`DELETE FROM "references" WHERE id=$1`, [ref]);
    });

    it("rejects reference_changed without reference_id or reference_event (CHECK 23514)", async () => {
      const ref = await makeReference();
      await expect(
        insertNotif({ recipient_id: alice, actor_id: null, kind: "reference_changed", post_id: postId, reference_event: "gone" }),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        insertNotif({ recipient_id: alice, actor_id: null, kind: "reference_changed", post_id: postId, reference_id: ref }),
      ).rejects.toMatchObject({ code: "23514" });
      await client.query(`DELETE FROM "references" WHERE id=$1`, [ref]);
    });

    it("dedupes on (reference_id, reference_event): same event collides (23505), a new event does not", async () => {
      const ref = await makeReference();
      const row = { recipient_id: alice, actor_id: null, kind: "reference_changed", post_id: postId, reference_id: ref };
      await insertNotif({ ...row, reference_event: "changed:h1" });
      await expect(insertNotif({ ...row, reference_event: "changed:h1" })).rejects.toMatchObject({ code: "23505" });
      await insertNotif({ ...row, reference_event: "changed:h2" });
      await client.query(`DELETE FROM "references" WHERE id=$1`, [ref]);
      await client.query("DELETE FROM notifications WHERE recipient_id=$1", [alice]);
    });

    it("cascade-deletes when its reference is removed", async () => {
      const ref = await makeReference();
      await insertNotif({
        recipient_id: alice, actor_id: null, kind: "reference_changed",
        post_id: postId, reference_id: ref, reference_event: "gone",
      });
      await client.query(`DELETE FROM "references" WHERE id=$1`, [ref]);
      const { rows } = await client.query("SELECT 1 FROM notifications WHERE reference_id=$1", [ref]);
      expect(rows).toHaveLength(0);
    });
  });

  it("cascade-deletes when the recipient, actor, or post is removed", async () => {
    const tmpPost = await makePost(alice);
    await insertNotif({ recipient_id: alice, actor_id: bob, kind: "post_comment", post_id: tmpPost });
    await client.query("DELETE FROM posts WHERE id=$1", [tmpPost]);
    const { rows } = await client.query("SELECT 1 FROM notifications WHERE post_id=$1", [tmpPost]);
    expect(rows).toHaveLength(0);
  });
});
