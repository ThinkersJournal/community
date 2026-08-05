import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";

import { SEARCH_MAX_OFFSET, SEARCH_PAGE_SIZE, SEARCH_Q_MAX, SEARCH_Q_MIN } from "@thinkersjournal/shared";

import worker from "../src";
import { withClient } from "../src/db/client";

const created: string[] = [];
afterAll(async () => {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(`DELETE FROM users WHERE id = ANY($1)`, [created]));
  await waitOnExecutionContext(ctx);
});

async function fetchWorker(url: string): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request(url), env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}

async function seedAuthorWithPost(title: string): Promise<{ username: string }> {
  const ctx = createExecutionContext();
  const username = `sada_${crypto.randomUUID().slice(0, 8)}`;
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`s-${crypto.randomUUID()}@t.test`]);
    const id = rows[0]!.id;
    created.push(id);
    await c.query(
      `INSERT INTO profiles (user_id, username, display_name, bio, username_chosen)
       VALUES ($1,$2,'Search Ada','bio text', true)`, [id, username]);
    await c.query(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1,$2,$3,'body', 'published', now())`,
      [id, title, `sl-${crypto.randomUUID()}`]);
  });
  await waitOnExecutionContext(ctx);
  return { username };
}

// Seeds ONE author with `n` published posts whose titles all share `term` (so the
// trigram matches every one of them). A single author keeps this from polluting
// the people-search tests with `n` extra matching profiles. Returns the post
// titles for cross-page coverage assertions.
async function seedAuthorWithNPosts(term: string, n: number): Promise<string[]> {
  const ctx = createExecutionContext();
  const titles = Array.from({ length: n }, (_, i) => `${term} number ${i}`);
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`s-${crypto.randomUUID()}@t.test`]);
    const id = rows[0]!.id;
    created.push(id);
    await c.query(
      `INSERT INTO profiles (user_id, username, display_name, bio, username_chosen)
       VALUES ($1,$2,'Pager Author','pager bio', true)`,
      [id, `pgr_${crypto.randomUUID().slice(0, 8)}`]);
    for (const title of titles) {
      await c.query(
        `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
         VALUES ($1,$2,$3,'body', 'published', now())`,
        [id, title, `sl-${crypto.randomUUID()}`]);
    }
  });
  await waitOnExecutionContext(ctx);
  return titles;
}

const U = "https://api.test";

describe("GET /public/search", () => {
  it("finds a published post by a partial+typo query, no session needed", async () => {
    await seedAuthorWithPost("Quantum Chromodynamics Primer");
    const r = await fetchWorker(`${U}/public/search?q=${encodeURIComponent("chromodynamcs")}&type=posts`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: { title: string }[]; nextOffset: number | null };
    expect(body.results.some((p) => p.title === "Quantum Chromodynamics Primer")).toBe(true);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("finds a person by partial name on the people tab", async () => {
    const { username } = await seedAuthorWithPost("Irrelevant Title Zzz");
    const r = await fetchWorker(`${U}/public/search?q=${encodeURIComponent("Search Ada")}&type=people`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: { username: string }[] };
    expect(body.results.some((p) => p.username === username)).toBe(true);
  });

  it("400s on q shorter than 2, longer than 100, and on a bad type/offset", async () => {
    expect((await fetchWorker(`${U}/public/search?q=a`)).status).toBe(400);
    expect((await fetchWorker(`${U}/public/search?q=${"x".repeat(101)}`)).status).toBe(400);
    expect((await fetchWorker(`${U}/public/search?q=abc&type=bogus`)).status).toBe(400);
    expect((await fetchWorker(`${U}/public/search?q=abc&offset=-1`)).status).toBe(400);
    expect((await fetchWorker(`${U}/public/search?q=abc&offset=201`)).status).toBe(400);
    expect((await fetchWorker(`${U}/public/search?q=abc&offset=abc`)).status).toBe(400);
  });

  it("defaults type to posts and returns nextOffset null on a small result set", async () => {
    // Seed our OWN distinctively-titled post so this test is self-contained (no
    // dependence on another test's seed or on run order). No `type` param — the
    // default MUST be posts. Assert on a POST-shaped field: people results carry no
    // `title`, so this fails if the default became people.
    const title = "Xylophone Sentinel Defaulting Post";
    await seedAuthorWithPost(title);
    const r = await fetchWorker(`${U}/public/search?q=${encodeURIComponent("Xylophone Sentinel")}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: { title?: string }[]; nextOffset: number | null };
    expect(body.results.some((p) => p.title === title)).toBe(true);
    expect(body.nextOffset).toBeNull();
  });

  it("accepts the valid-side length/offset boundaries (q=MIN, q=MAX, offset=MAX)", async () => {
    // Guards against an off-by-one flip (`>` -> `>=`) rejecting legitimate input:
    // the shortest/longest allowed q, and the deepest offset the pager emits.
    expect((await fetchWorker(`${U}/public/search?q=${"a".repeat(SEARCH_Q_MIN)}`)).status).toBe(200);
    expect((await fetchWorker(`${U}/public/search?q=${"a".repeat(SEARCH_Q_MAX)}`)).status).toBe(200);
    expect(
      (await fetchWorker(`${U}/public/search?q=abc&offset=${SEARCH_MAX_OFFSET}`)).status,
    ).toBe(200);
  });

  it("paginates a >PAGE_SIZE result set: full first page + capped nextOffset, then the tail", async () => {
    const term = "zqpagerterm"; // distinctive: matches all seeded titles, nothing else in the DB
    const n = SEARCH_PAGE_SIZE + 1; // 21 — exactly one over a full page
    await seedAuthorWithNPosts(term, n);

    const first = await fetchWorker(`${U}/public/search?q=${term}&type=posts`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      results: { title: string }[];
      nextOffset: number | null;
    };
    // Full page, and the +1 sentinel drives a nextOffset one page forward.
    expect(firstBody.results.length).toBe(SEARCH_PAGE_SIZE);
    expect(firstBody.nextOffset).toBe(SEARCH_PAGE_SIZE);

    const second = await fetchWorker(`${U}/public/search?q=${term}&type=posts&offset=${SEARCH_PAGE_SIZE}`);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      results: { title: string }[];
      nextOffset: number | null;
    };
    // The 21st row lands alone on the tail page; no sentinel beyond it.
    expect(secondBody.results.length).toBe(1);
    expect(secondBody.nextOffset).toBeNull();

    // The two pages together cover all 21 distinct rows (proves LIMIT/OFFSET +
    // the slice of the +1 sentinel actually walked the whole set, no overlap).
    const page1 = new Set(firstBody.results.map((r) => r.title));
    const tailTitle = secondBody.results[0]!.title;
    expect(page1.has(tailTitle)).toBe(false);
    expect(new Set([...page1, tailTitle]).size).toBe(n);
  });
});
