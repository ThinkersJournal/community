import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { listOpenQueue } from "../src/moderation/queue";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
const madeUsers: string[] = [];

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});
afterAll(async () => { await client.end(); });

// Every fixture hangs off a user; ON DELETE CASCADE removes posts, comments and
// reports with it. moderation_actions has NO FK (module 2a, deliberately).
//
// ⚠️ It is ALSO append-only, enforced by a database trigger (migration 0013,
// `moderation_actions_no_update`) that unconditionally RAISEs on any UPDATE or
// DELETE, per row, regardless of WHERE clause -- proven in
// moderation-actions.db.test.ts, which itself never attempts to delete a row
// for exactly this reason. A `DELETE ... WHERE actor_admin = 'queue-test'`
// here throws the moment this suite has written even one row (i.e. from the
// first test that calls act()), which would abort this hook before the users
// cleanup below runs. So: leave moderation_actions rows in place, same as
// moderation-actions.db.test.ts does. Each test here uses a fresh
// randomUUID() post/comment id, so leftover rows from earlier runs never
// match a later run's targets and cannot affect its assertions.
afterEach(async () => {
  if (madeUsers.length > 0) {
    await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]);
    madeUsers.length = 0;
  }
});

async function mkUser(): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO users (id, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'h', now())`, [id, `${id}@queue.test`],
  );
  madeUsers.push(id);
  return id;
}

async function mkPost(author: string, title: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO posts (id, author_id, title, slug, markdown_source, status, published_at)
     VALUES ($1, $2, $3, $4, 'body', 'published', now())`,
    [id, author, title, `${id}-slug`],
  );
  return id;
}

async function report(reporter: string, postId: string, reason: string, minutesAgo = 0): Promise<void> {
  await client.query(
    `INSERT INTO reports (reporter_id, post_id, reason, created_at)
     VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval)`,
    [reporter, postId, reason, String(minutesAgo)],
  );
}

async function act(postId: string, action: string): Promise<void> {
  await client.query(
    `INSERT INTO moderation_actions (actor_admin, action, post_id, reason)
     VALUES ('queue-test', $1, $2, 'test')`, [action, postId],
  );
}

const idsOf = (items: { targetId: string }[]): string[] => items.map((i) => i.targetId);

describe("listOpenQueue", () => {
  it("returns a reported post as an OPEN item, with its report count", async () => {
    const author = await mkUser();
    const r1 = await mkUser();
    const post = await mkPost(author, "Reported");
    await report(r1, post, "spam");

    const items = await listOpenQueue(client);
    const mine = items.find((i) => i.targetId === post);
    expect(mine).toBeDefined();
    expect(mine!.kind).toBe("post");
    expect(mine!.reportCount).toBe(1);
  });

  it("⚠️ SEVERITY OUTRANKS COUNT — one 'sexual' report sorts above two 'spam'", async () => {
    const author = await mkUser();
    const [r1, r2, r3] = [await mkUser(), await mkUser(), await mkUser()];
    const spammy = await mkPost(author, "Spammy");
    const severe = await mkPost(author, "Severe");
    await report(r1, spammy, "spam", 30);
    await report(r2, spammy, "spam", 20);
    await report(r3, severe, "sexual", 10);

    const ids = idsOf(await listOpenQueue(client));
    expect(ids.indexOf(severe)).toBeLessThan(ids.indexOf(spammy));
  });

  it("DROPS an item once a content_ action is recorded after its newest report", async () => {
    const author = await mkUser();
    const r1 = await mkUser();
    const post = await mkPost(author, "Decided");
    await report(r1, post, "spam", 10);
    expect(idsOf(await listOpenQueue(client))).toContain(post);

    await act(post, "content_keep_hidden");
    expect(idsOf(await listOpenQueue(client))).not.toContain(post);
  });

  it("⚠️ REOPENS when a DIFFERENT reporter reports after the decision", async () => {
    // The same reporter cannot reopen: reports_reporter_post_unique allows one
    // report per reporter per target. Only a distinct reporter can.
    const author = await mkUser();
    const r1 = await mkUser();
    const r2 = await mkUser();
    const post = await mkPost(author, "Reopened");
    await report(r1, post, "spam", 10);
    await act(post, "content_keep_hidden");
    expect(idsOf(await listOpenQueue(client))).not.toContain(post);

    await report(r2, post, "hate");
    const items = await listOpenQueue(client);
    expect(idsOf(items)).toContain(post);
    expect(items.find((i) => i.targetId === post)!.reportCount).toBe(2);
  });

  it("a NON-content action does NOT close an item (only content_ decisions do)", async () => {
    const author = await mkUser();
    const r1 = await mkUser();
    const post = await mkPost(author, "Warned");
    await report(r1, post, "spam", 10);
    await act(post, "user_warn");
    expect(idsOf(await listOpenQueue(client))).toContain(post);
  });
});
