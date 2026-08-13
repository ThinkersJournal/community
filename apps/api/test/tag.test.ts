import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createPostRequest, createVerifiedActor, deleteCreatedUsers } from "./actor";

const created: string[] = [];
afterAll(async () => {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(`DELETE FROM users WHERE id = ANY($1)`, [created]));
  await waitOnExecutionContext(ctx);
  // Fix-B's test creates its author through the actor fixture (HTTP create path),
  // which tracks its own user ids — clean those up too.
  await deleteCreatedUsers();
});

async function fetchWorker(url: string): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request(url), env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}

async function dispatch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(request, env, ctx);
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
      `INSERT INTO profiles (user_id, username, display_name)
       VALUES ($1,$2,'Tag Author')`,
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

  it("canonicalizes a mixed-case slug to the lowercase form the web cache tag keys off (Fix A)", async () => {
    // The web page (apps/web/src/pages/tag/[slug].astro) keys its edge-cache tag
    // off `page.tag.slug`, and the api purge (posts.ts) always emits the lowercase
    // `tag:<slug>`. `tag.slug` must therefore ALWAYS be the canonical lowercase
    // value, so /tag/AI and /tag/ai are one cache entry (migration 0010's promise).

    // KNOWN tag, queried in MIXED case → the slug echoed back is canonical.
    const author = await seedAuthor();
    const slug = `rustlang-${crypto.randomUUID().slice(0, 8)}`; // already canonical (lowercase)
    const t = await tagId(slug);
    const pubId = await insertPost(author, "Rust Canon", "published");
    await attachTag(pubId, t);
    const known = await fetchWorker(
      `${U}/public/tag?slug=${encodeURIComponent(slug.toUpperCase())}` +
        `&cursor=${encodeURIComponent(uuidSuccessor(pubId))}`,
    );
    expect(known.status).toBe(200);
    const kbody = (await known.json()) as {
      tag: { slug: string; label: string }; posts: { id: string }[];
    };
    expect(kbody.tag.slug).toBe(slug);                     // lowercase/canonical, not the RAW upper param
    expect(kbody.posts.map((p) => p.id)[0]).toBe(pubId);   // the published post still resolves

    // UNKNOWN tag, queried in MIXED case → the FALLBACK label/slug is the LOWERCASED
    // param (this is the path Fix A actually repairs — the fallback used to echo raw case).
    const unknown = await fetchWorker(`${U}/public/tag?slug=ZZUnknownMixedCase${crypto.randomUUID().slice(0, 8)}`);
    expect(unknown.status).toBe(200);
    const ubody = (await unknown.json()) as { tag: { slug: string; label: string }; posts: unknown[] };
    expect(ubody.tag.slug).toBe(ubody.tag.slug.toLowerCase());   // no uppercase survived
    expect(ubody.tag.slug.startsWith("zzunknownmixedcase")).toBe(true);
    expect(ubody.tag.label).toBe(ubody.tag.slug);                // fallback label == canonical slug
    expect(ubody.posts).toEqual([]);
  });

  it("does NOT disclose the label of a tag carried only by an unpublished draft (Fix B)", async () => {
    // A DRAFT create still runs writeTags, upserting the tag into the GLOBAL `tags`
    // table (posts.ts insertPost → writeTags, regardless of status). A draft is
    // exempt from the publish-username gate, so a plain verified actor can create it.
    const actor = await createVerifiedActor();
    const rand = crypto.randomUUID().slice(0, 8);
    const displayLabel = `DraftOnlyTag${rand}`;         // mixed case → slug is its lowercase
    const canonicalSlug = displayLabel.toLowerCase();   // draftonlytag<rand>
    const create = await dispatch(createPostRequest(actor, "draft", { tags: [displayLabel] }));
    expect(create.status).toBe(201);

    const r = await fetchWorker(`${U}/public/tag?slug=${encodeURIComponent(canonicalSlug)}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { tag: { slug: string; label: string }; posts: unknown[] };
    // The tag EXISTS in `tags`, but NO published post carries it → it must be
    // indistinguishable from a never-existed tag: the label falls back to the slug
    // and does NOT leak the draft's display label or its existence.
    expect(body.tag.slug).toBe(canonicalSlug);
    expect(body.tag.label).toBe(canonicalSlug);         // NOT the draft's display label
    expect(body.tag.label).not.toBe(displayLabel);
    expect(body.posts).toEqual([]);                     // published-only keyset → empty
  });

  it("canonicalizes a non-[a-z0-9-] slug (spaces/punctuation) to the purgeable form, never the raw param (Copilot #1)", async () => {
    // The web page caches under `tag:${page.tag.slug}`, and the purge only ever
    // emits `tag:<slug>` for a `[a-z0-9-]` slug (posts.ts slugifyBase). A
    // `?slug=foo bar` that echoed back `foo bar` would cache under `tag:foo bar`
    // — a tag no purge can name (~25h unpurgeable). `tag.slug` MUST canonicalize
    // for BOTH a known tag (must still resolve) and an unknown one.
    const author = await seedAuthor();
    const canonical = `multi-word-${crypto.randomUUID().slice(0, 8)}`; // already canonical
    const t = await tagId(canonical);
    const pubId = await insertPost(author, "Spaced Query", "published");
    await attachTag(pubId, t);
    // Same tag, queried with interior spaces + upper-case + a trailing bang.
    const noisy = `${canonical.replace(/-/g, " ").toUpperCase()} !`;
    const known = await fetchWorker(
      `${U}/public/tag?slug=${encodeURIComponent(noisy)}` +
        `&cursor=${encodeURIComponent(uuidSuccessor(pubId))}`,
    );
    expect(known.status).toBe(200);
    const kbody = (await known.json()) as {
      tag: { slug: string; label: string }; posts: { id: string }[];
    };
    expect(kbody.tag.slug).toBe(canonical);              // purgeable canonical form, NOT "multi word ..."
    expect(kbody.tag.slug).toMatch(/^[a-z0-9-]+$/);      // no space/punctuation/uppercase survived
    expect(kbody.posts.map((p) => p.id)[0]).toBe(pubId); // the real tag still resolves

    // Unknown non-canonical slug: still a 200 empty page, but the echoed slug
    // (the web cache tag) is canonical, never `tag:foo bar ...`.
    const unknown = await fetchWorker(
      `${U}/public/tag?slug=${encodeURIComponent(`foo bar ${crypto.randomUUID().slice(0, 8)}`)}`,
    );
    expect(unknown.status).toBe(200);
    const ubody = (await unknown.json()) as { tag: { slug: string }; posts: unknown[] };
    expect(ubody.tag.slug).toMatch(/^[a-z0-9-]+$/);
    expect(ubody.tag.slug.startsWith("foo-bar-")).toBe(true);
    expect(ubody.posts).toEqual([]);
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

  it("400s a slug with no [a-z0-9] content (punctuation only) — the web page maps this to 404 (Copilot #1/#2)", async () => {
    expect((await fetchWorker(`${U}/public/tag?slug=${encodeURIComponent("!!!")}`)).status).toBe(400);
  });
});
