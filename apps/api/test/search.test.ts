import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
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
    const r = await fetchWorker(`${U}/public/search?q=${encodeURIComponent("Quantum")}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { nextOffset: number | null };
    expect(body.nextOffset).toBeNull();
  });
});
