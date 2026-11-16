// SPDX-License-Identifier: MIT OR Apache-2.0
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { touchViewed, VIEW_TOUCH_MIN_MS } from "../src/references/view-touch";

/**
 * touchViewed (M3.2d part 2, plan decision 22: "a view serves the last known state and enqueues a refresh for next time ...
 * an unviewed reference goes dormant and wakes on its next view"). A public read of a post records `last_viewed_at` on the
 * references the post uses, and wakes a DORMANT one (`next_check_at` NULL) by making it due now, so the next sweep tick
 * claims it. Rows sit in the year 2000 and `now` is in 2000, so other test files' rows are never matched (the query only
 * touches references used by the post ids it is given anyway).
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

const NOW = new Date("2000-06-01T12:00:00.000Z");
const ms = (n: number): Date => new Date(NOW.getTime() + n);

let client: Client;
const referenceIds: string[] = [];
const postIds: string[] = [];
const userIds: string[] = [];
let tokenSeq = 0;

async function newPost(): Promise<string> {
  const uid = randomUUID();
  await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'h')", [uid, `${uid}@refs-touch.test`]);
  userIds.push(uid);
  await client.query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [uid, `v${uid.replace(/-/g, "").slice(0, 20)}`]);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO posts (author_id, slug, title, markdown_source) VALUES ($1, $2, 'A title', 'body') RETURNING id`,
    [uid, `s-${randomUUID()}`],
  );
  postIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function seedRef(opts: { next?: Date | null; viewed?: Date | null; gone?: boolean }): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO "references" (kind, resource_key, content_hash, next_check_at, last_viewed_at, gone_at)
     VALUES ('web', $1, $2, $3, $4, $5) RETURNING id`,
    [`web:https://example.com/${randomUUID()}`, randomUUID(), opts.next ?? null, opts.viewed ?? null, opts.gone === true ? NOW : null],
  );
  referenceIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function use(postId: string, referenceId: string): Promise<void> {
  tokenSeq += 1;
  const token = `${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[tokenSeq % 26]}${String(tokenSeq).padStart(11, "2")}`.replace(/[^A-Z2-7]/g, "2");
  await client.query(`INSERT INTO post_references (post_id, reference_id, token) VALUES ($1, $2, $3)`, [postId, referenceId, token]);
}

async function stateOf(id: string): Promise<{ viewed: Date | null; next: Date | null }> {
  const { rows } = await client.query<{ last_viewed_at: Date | null; next_check_at: Date | null }>(
    `SELECT last_viewed_at, next_check_at FROM "references" WHERE id = $1`,
    [id],
  );
  return { viewed: rows[0]!.last_viewed_at, next: rows[0]!.next_check_at };
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.query(`DELETE FROM posts WHERE id = ANY($1::uuid[])`, [postIds]);
  await client.query(`DELETE FROM "references" WHERE id = ANY($1::uuid[])`, [referenceIds]);
  await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
  await client.end();
});

describe("touchViewed", () => {
  it("records the view and wakes a dormant reference by making it due now (mutation: no wake, or wake to a later time)", async () => {
    const post = await newPost();
    const dormant = await seedRef({});
    await use(post, dormant);
    const n = await touchViewed(client, [post], NOW);
    expect(n).toBe(1);
    const s = await stateOf(dormant);
    expect(s.viewed?.toISOString()).toBe(NOW.toISOString());
    expect(s.next?.toISOString()).toBe(NOW.toISOString());
  });

  it("records the view but leaves a scheduled next_check_at alone (a taper or a lease is never pulled forward)", async () => {
    const post = await newPost();
    const scheduled = await seedRef({ next: ms(3_600_000), viewed: ms(-3_600_000) });
    await use(post, scheduled);
    await touchViewed(client, [post], NOW);
    const s = await stateOf(scheduled);
    expect(s.viewed?.toISOString()).toBe(NOW.toISOString());
    expect(s.next?.toISOString()).toBe(ms(3_600_000).toISOString());
  });

  it("does not wake a gone reference, and does not touch one the given posts do not use", async () => {
    const post = await newPost();
    const gone = await seedRef({ gone: true });
    await use(post, gone);
    const unrelatedPost = await newPost();
    const unrelated = await seedRef({});
    await use(unrelatedPost, unrelated);
    await touchViewed(client, [post], NOW);
    expect((await stateOf(gone)).next).toBeNull();
    expect(await stateOf(unrelated)).toEqual({ viewed: null, next: null });
  });

  it("is throttled: a view inside VIEW_TOUCH_MIN_MS of the last one writes nothing, one after it does", async () => {
    const post = await newPost();
    const recent = await seedRef({ viewed: ms(-(VIEW_TOUCH_MIN_MS - 1_000)) });
    const stale = await seedRef({ viewed: ms(-(VIEW_TOUCH_MIN_MS + 1_000)) });
    await use(post, recent);
    await use(post, stale);
    const n = await touchViewed(client, [post], NOW);
    expect(n).toBe(1);
    expect((await stateOf(recent)).viewed?.toISOString()).toBe(ms(-(VIEW_TOUCH_MIN_MS - 1_000)).toISOString());
    expect((await stateOf(stale)).viewed?.toISOString()).toBe(NOW.toISOString());
  });

  it("does nothing, and sends no query it cannot answer, for an empty post list", async () => {
    expect(await touchViewed(client, [], NOW)).toBe(0);
  });
});
