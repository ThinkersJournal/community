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
      [`tag-${crypto.randomUUID()}@t.test`]);
    id = rows[0]!.id;
    created.push(id);
    await c.query(
      `INSERT INTO profiles (user_id, username, display_name, username_chosen)
       VALUES ($1,$2,'Tag Author', true)`,
      [id, `tagr_${crypto.randomUUID().slice(0, 8)}`]);
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
      [authorId, title, `tag-${crypto.randomUUID()}`, status]);
    postId = rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return postId;
}

/**
 * Creates (or reuses, citext-collapsed) a tag row and returns its id.
 * NOTE: `$1,$2` bound to the same JS value, not `$1,$1` — reusing one
 * placeholder for both the citext `slug` column and the text `label` column
 * throws "inconsistent types deduced for parameter $1" under pg's extended
 * query protocol (see test/tags.db.test.ts).
 */
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

// The smallest uuid strictly greater than `id` (its 128-bit successor). Querying
// `/public/tag?cursor=<successor(pubId)>` restricts the keyset to `id <= pubId`,
// so a just-inserted published row is result #1 regardless of how many OTHER
// (larger-id) posts parallel pool-project test files commit concurrently — this
// test's newest-first assertion is then deterministic, not top-20-site-wide.
function uuidSuccessor(id: string): string {
  const next = (BigInt("0x" + id.replace(/-/g, "")) + 1n).toString(16).padStart(32, "0");
  return `${next.slice(0, 8)}-${next.slice(8, 12)}-${next.slice(12, 16)}-${next.slice(16, 20)}-${next.slice(20)}`;
}

describe("GET /public/tag", () => {
  it("returns the published post carrying the tag, not a draft carrying the same tag", async () => {
    const author = await seedAuthor();
    const slug = `topic-${crypto.randomUUID().slice(0, 8)}`;
    const t = await tagId(slug);
    // Draft first (older id) so it sits INSIDE the cursor window below and its
    // absence proves the status='published' filter, not the cursor bound.
    const draftId = await insertPost(author, "Tag Draft One", "draft");
    await attachTag(draftId, t);
    const pubId = await insertPost(author, "Tag Published One", "published");
    await attachTag(pubId, t);

    const r = await fetchWorker(
      `${U}/public/tag?slug=${slug}&cursor=${encodeURIComponent(uuidSuccessor(pubId))}`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store"); // FRESH api hop, never cached here
    const body = (await r.json()) as {
      tag: { slug: string; label: string };
      posts: { id: string }[];
      nextCursor: string | null;
    };
    expect(body.tag.slug.toLowerCase()).toBe(slug.toLowerCase());
    const ids = body.posts.map((p) => p.id);
    expect(ids[0]).toBe(pubId);          // the just-published post is result #1 (newest <= pubId)
    expect(ids).not.toContain(draftId);  // drafts never surface (excluded by status, not cursor)
  });

  it("keyset-paginates: a full page yields a nextCursor onto a non-overlapping older page", async () => {
    const author = await seedAuthor();
    const slug = `paging-${crypto.randomUUID().slice(0, 8)}`;
    const t = await tagId(slug);
    for (let i = 0; i < 21; i++) {
      const p = await insertPost(author, `Tag Paging ${i}`, "published");
      await attachTag(p, t);
    }
    const p1 = (await (await fetchWorker(`${U}/public/tag?slug=${slug}`)).json()) as {
      posts: { id: string }[]; nextCursor: string | null;
    };
    expect(p1.posts.length).toBe(20);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = (await (await fetchWorker(
      `${U}/public/tag?slug=${slug}&cursor=${encodeURIComponent(p1.nextCursor!)}`,
    )).json()) as { posts: { id: string }[]; nextCursor: string | null };
    const ids1 = new Set(p1.posts.map((p) => p.id));
    expect(p2.posts.length).toBe(1);
    for (const p of p2.posts) {
      expect(ids1.has(p.id)).toBe(false);        // no overlap between pages
      expect(p.id < p1.nextCursor!).toBe(true);  // strictly older than the cursor
    }
  });

  it("an unknown slug 200s with an empty page, falling back to the slug as the label", async () => {
    const slug = `nonexistent-${crypto.randomUUID()}`;
    const r = await fetchWorker(`${U}/public/tag?slug=${slug}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { tag: { slug: string; label: string }; posts: unknown[] };
    expect(body.posts).toEqual([]);
    expect(body.tag).toEqual({ slug, label: slug });
  });

  it("400s a malformed cursor rather than 500ing", async () => {
    expect((await fetchWorker(`${U}/public/tag?slug=whatever&cursor=not-a-uuid`)).status).toBe(400);
  });

  it("400s a blank slug", async () => {
    expect((await fetchWorker(`${U}/public/tag?slug=`)).status).toBe(400);
  });

  it("400s a whitespace-only slug", async () => {
    expect((await fetchWorker(`${U}/public/tag?slug=${encodeURIComponent("   ")}`)).status).toBe(400);
  });
});
