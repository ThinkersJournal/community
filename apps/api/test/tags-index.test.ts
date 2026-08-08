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

async function seedAuthor(): Promise<string> {
  const ctx = createExecutionContext();
  let id = "";
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`tagidx-${crypto.randomUUID()}@t.test`]);
    id = rows[0]!.id;
    created.push(id);
    await c.query(
      `INSERT INTO profiles (user_id, username, display_name, username_chosen)
       VALUES ($1,$2,'Tag Index Author', true)`,
      [id, `tagidxr_${crypto.randomUUID().slice(0, 8)}`]);
  });
  await waitOnExecutionContext(ctx);
  return id;
}

async function insertPost(
  authorId: string, title: string, status: "published" | "draft",
): Promise<string> {
  const ctx = createExecutionContext();
  let postId = "";
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1,$2,$3,'body',$4, CASE WHEN $4 = 'published' THEN now() ELSE NULL END)
       RETURNING id`,
      [authorId, title, `tagidx-${crypto.randomUUID()}`, status]);
    postId = rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return postId;
}

/** See test/tag.test.ts's tagId for why this uses two placeholders, not one reused. */
async function tagId(slug: string): Promise<string> {
  const ctx = createExecutionContext();
  let id = "";
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO tags (slug,label) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`,
      [slug, slug]);
    id = rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return id;
}

async function attachTag(postId: string, tId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(`INSERT INTO post_tags (post_id, tag_id) VALUES ($1,$2)`, [postId, tId]));
  await waitOnExecutionContext(ctx);
}

const U = "https://api.test";

describe("GET /public/tags", () => {
  it("orders two tags by published-post count desc", async () => {
    const author = await seedAuthor();
    const suffix = crypto.randomUUID().slice(0, 8);
    const popularSlug = `popular-${suffix}`;
    const rareSlug = `rare-${suffix}`;
    const popular = await tagId(popularSlug);
    const rare = await tagId(rareSlug);

    for (let i = 0; i < 3; i++) {
      const p = await insertPost(author, `Popular ${i}`, "published");
      await attachTag(p, popular);
    }
    const rarePost = await insertPost(author, "Rare", "published");
    await attachTag(rarePost, rare);

    const body = (await (await fetchWorker(`${U}/public/tags`)).json()) as {
      tags: { slug: string; label: string; count: number }[];
    };
    const bySlug = new Map(body.tags.map((t) => [t.slug.toLowerCase(), t]));
    expect(bySlug.get(popularSlug)?.count).toBe(3);
    expect(bySlug.get(rareSlug)?.count).toBe(1);

    const popularIdx = body.tags.findIndex((t) => t.slug.toLowerCase() === popularSlug);
    const rareIdx = body.tags.findIndex((t) => t.slug.toLowerCase() === rareSlug);
    expect(popularIdx).toBeGreaterThanOrEqual(0);
    expect(rareIdx).toBeGreaterThanOrEqual(0);
    expect(popularIdx).toBeLessThan(rareIdx); // higher count sorts first
  });

  it("a tag with only a draft has count 0 and is absent — drafts don't inflate counts", async () => {
    const author = await seedAuthor();
    const slug = `draft-only-${crypto.randomUUID().slice(0, 8)}`;
    const t = await tagId(slug);
    const draft = await insertPost(author, "Draft Only", "draft");
    await attachTag(draft, t);

    const body = (await (await fetchWorker(`${U}/public/tags`)).json()) as {
      tags: { slug: string; label: string; count: number }[];
    };
    expect(body.tags.some((tag) => tag.slug.toLowerCase() === slug)).toBe(false);
  });
});
