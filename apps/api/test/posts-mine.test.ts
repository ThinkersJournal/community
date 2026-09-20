import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor } from "./actor";

import type { Actor } from "./actor";

/**
 * `GET /posts/by-slug` and `GET /posts` (#78) — the author's own posts
 * beyond a single one by id.
 */

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

async function seedPost(
  actor: Actor,
  opts: { status?: "draft" | "published"; hiddenAt?: Date } = {},
): Promise<{ id: string; slug: string }> {
  return ctxRun(async (c) => {
    const slug = "test-" + crypto.randomUUID().slice(0, 8);
    const status = opts.status ?? "published";
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at, hidden_at)
       VALUES ($1, 'test', $2, 'test', $3, CASE WHEN $3 = 'published' THEN now() ELSE NULL END, $4)
       RETURNING id`,
      [actor.userId, slug, status, opts.hiddenAt ?? null],
    );
    return { id: rows[0]!.id, slug };
  });
}

async function moderatorKeepHidden(postId: string): Promise<void> {
  await ctxRun((c) =>
    c.query(
      `INSERT INTO moderation_actions (actor_admin, action, post_id, reason) VALUES ('mod@example.test', 'content_keep_hidden', $1, 'r')`,
      [postId],
    ),
  );
}

async function authorHideAction(postId: string): Promise<void> {
  await ctxRun((c) =>
    c.query(
      `INSERT INTO moderation_actions (actor_admin, action, post_id, reason) VALUES ('a@example.test', 'author_hide', $1, 'r')`,
      [postId],
    ),
  );
}

function getBySlug(actor: Actor, slug: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/posts/by-slug?slug=${encodeURIComponent(slug)}`, {
      headers: { Cookie: actor.cookie },
    }),
  );
}
function listMine(actor: Actor, cursor?: string): Promise<Response> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return fetchWorker(new Request(`https://api.test/posts${q}`, { headers: { Cookie: actor.cookie } }));
}

describe("GET /posts/by-slug — route-ordering regression (PM review condition 2)", () => {
  it("resolves to the real by-slug handler, NOT handleGetPost's :id route — proven by a correct 200, not just registration order", async () => {
    // ⚠️ THE DIRECT PROOF, not a trust-the-registration-order assertion: if
    // `/posts/by-slug` were EVER swallowed by `/posts/:id` (findRoute matching
    // `:id = "by-slug"`), handleGetPost would run `WHERE p.id = 'by-slug'`,
    // which throws 22P02 (invalid uuid) and is caught into a 404 — never a
    // 200 with the real post's data. A 200 carrying the CORRECT slug/title is
    // therefore only reachable through the real by-slug handler.
    const author = await createVerifiedActor();
    const { id, slug } = await seedPost(author);

    const res = await getBySlug(author, slug);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; slug: string };
    expect(body.id).toBe(id);
    expect(body.slug).toBe(slug);
  });

  it("404s an unknown slug rather than misrouting to :id and 404ing for a DIFFERENT reason", async () => {
    const author = await createVerifiedActor();
    const res = await getBySlug(author, "definitely-not-a-real-slug");
    expect(res.status).toBe(404);
  });
});

describe("GET /posts/by-slug — ownership + hiddenReason", () => {
  it("404s a slug belonging to a DIFFERENT author", async () => {
    const owner = await createVerifiedActor();
    const stranger = await createVerifiedActor();
    const { slug } = await seedPost(owner);

    const res = await getBySlug(stranger, slug);
    expect(res.status).toBe(404);
  });

  it("hiddenReason is null for a visible post", async () => {
    const author = await createVerifiedActor();
    const { slug } = await seedPost(author);
    const res = await getBySlug(author, slug);
    const body = (await res.json()) as { hiddenReason: string | null };
    expect(body.hiddenReason).toBeNull();
  });

  it("hiddenReason is 'author' after an author_hide action", async () => {
    const author = await createVerifiedActor();
    const { id, slug } = await seedPost(author, { hiddenAt: new Date() });
    await authorHideAction(id);
    const res = await getBySlug(author, slug);
    const body = (await res.json()) as { hiddenReason: string | null };
    expect(body.hiddenReason).toBe("author");
  });

  it("hiddenReason is 'moderation' for an auto-hide with no decision yet (no action row at all)", async () => {
    const author = await createVerifiedActor();
    const { slug } = await seedPost(author, { hiddenAt: new Date() });
    const res = await getBySlug(author, slug);
    const body = (await res.json()) as { hiddenReason: string | null };
    expect(body.hiddenReason).toBe("moderation");
  });

  it("hiddenReason is 'moderation' after a moderator's keep_hidden decision", async () => {
    const author = await createVerifiedActor();
    const { id, slug } = await seedPost(author, { hiddenAt: new Date() });
    await moderatorKeepHidden(id);
    const res = await getBySlug(author, slug);
    const body = (await res.json()) as { hiddenReason: string | null };
    expect(body.hiddenReason).toBe("moderation");
  });
});

describe("GET /posts — the caller's own listing, every status", () => {
  it("includes drafts and hidden posts, scoped to the caller only", async () => {
    const author = await createVerifiedActor();
    const stranger = await createVerifiedActor();
    const published = await seedPost(author);
    const draft = await seedPost(author, { status: "draft" });
    const hidden = await seedPost(author, { hiddenAt: new Date() });
    const strangersPost = await seedPost(stranger);

    const res = await listMine(author);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posts: { id: string }[]; nextCursor: string | null };
    const ids = body.posts.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([published.id, draft.id, hidden.id]));
    expect(ids).not.toContain(strangersPost.id);
  });

  it("each row carries hiddenReason", async () => {
    const author = await createVerifiedActor();
    const { id } = await seedPost(author, { hiddenAt: new Date() });
    await authorHideAction(id);

    const res = await listMine(author);
    const body = (await res.json()) as { posts: { id: string; hiddenReason: string | null }[] };
    const row = body.posts.find((p) => p.id === id);
    expect(row?.hiddenReason).toBe("author");
  });
});
