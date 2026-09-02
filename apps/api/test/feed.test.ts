import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedFollow(followerId: string, followeeId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [
      followerId,
      followeeId,
    ]),
  );
  await waitOnExecutionContext(ctx);
}

/** Insert a `blocks` row directly (M4 Task 6 — feed filtering, not the block route itself). */
async function seedBlock(blockerId: string, blockedId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [
      blockerId,
      blockedId,
    ]),
  );
  await waitOnExecutionContext(ctx);
}

/** Insert a post directly (status controls visibility) and return its id. */
async function seedPost(authorId: string, title: string, status: "draft" | "published"): Promise<string> {
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1,$2,$3,'body',$4, CASE WHEN $4='published' THEN now() ELSE NULL END)
       RETURNING id`,
      [authorId, title, `${title}-${crypto.randomUUID()}`.slice(0, 40), status],
    );
    return rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return id;
}

/**
 * M2.4c Task 5 — tags on `/feed`. Mirrors test/tag.test.ts's `tagId`/`attachTag`:
 * this file seeds posts by direct SQL (not through `POST /posts`), so tags need
 * the same direct-SQL path.
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

function getFeed(actor: Actor, cursor?: string): Promise<Response> {
  const q = cursor === undefined ? "" : `?cursor=${cursor}`;
  return fetchWorker(new Request(`https://api.test/feed${q}`, { headers: { Cookie: actor.cookie } }));
}

let viewer: Actor;
let followed: Actor;
let stranger: Actor;
beforeAll(async () => {
  viewer = await createVerifiedActor();
  followed = await createVerifiedActor();
  stranger = await createVerifiedActor();
  await seedFollow(viewer.userId, followed.userId);
});
afterAll(async () => {
  await deleteCreatedUsers();
});

describe("GET /feed", () => {
  it("shows a followed author's PUBLISHED post", async () => {
    const postId = await seedPost(followed.userId, "followed-published", "published");
    const slug = `feed-topic-${crypto.randomUUID().slice(0, 8)}`;
    await attachTag(postId, await tagId(slug));
    const response = await getFeed(viewer);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      posts: { username: string; title: string; tags: { slug: string; label: string }[] }[];
    };
    const mine = body.posts.find((p) => p.username === followed.username);
    expect(mine).toBeDefined();
    expect(mine!.tags).toEqual([{ slug, label: slug }]);
  });

  it("never shows a followed author's DRAFT", async () => {
    await seedPost(followed.userId, "followed-draft", "draft");
    const body = (await getFeed(viewer).then((r) => r.json())) as { posts: { title: string }[] };
    expect(body.posts.some((p) => p.title === "followed-draft")).toBe(false);
  });

  it("never shows a NON-followed author's post", async () => {
    await seedPost(stranger.userId, "stranger-published", "published");
    const body = (await getFeed(viewer).then((r) => r.json())) as { posts: { title: string }[] };
    expect(body.posts.some((p) => p.title === "stranger-published")).toBe(false);
  });

  it("returns an empty feed (not an error) for a viewer who follows no one", async () => {
    const lonely = await createVerifiedActor();
    const response = await getFeed(lonely);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { posts: unknown[]; nextCursor: string | null };
    expect(body.posts).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("populates the viewer's KV followee cache on a feed read (wired through getFolloweeIds)", async () => {
    const reader = await createVerifiedActor();
    const author = await createVerifiedActor();
    await seedFollow(reader.userId, author.userId);
    expect(await env.FOLLOWEES.get(`followees:${reader.userId}`)).toBeNull(); // cold
    await getFeed(reader);
    expect(await env.FOLLOWEES.get(`followees:${reader.userId}`))
      .toBe(JSON.stringify([author.userId]));
  });

  it("401s without a session", async () => {
    const response = await fetchWorker(new Request("https://api.test/feed"));
    expect(response.status).toBe(401);
  });

  it("400s on a malformed cursor", async () => {
    const response = await getFeed(viewer, "not-a-uuid");
    expect(response.status).toBe(400);
  });

  it("filters out a BLOCKED followee's post while a non-blocked followee's post still shows (M4 Task 6)", async () => {
    const filterViewer = await createVerifiedActor();
    const blockedFollowee = await createVerifiedActor();
    const okFollowee = await createVerifiedActor();
    await seedFollow(filterViewer.userId, blockedFollowee.userId);
    await seedFollow(filterViewer.userId, okFollowee.userId);
    await seedBlock(filterViewer.userId, blockedFollowee.userId);

    await seedPost(blockedFollowee.userId, "blocked-author-post", "published");
    await seedPost(okFollowee.userId, "ok-author-post", "published");

    const body = (await getFeed(filterViewer).then((r) => r.json())) as {
      posts: { title: string }[];
    };
    expect(body.posts.some((p) => p.title === "blocked-author-post")).toBe(false);
    expect(body.posts.some((p) => p.title === "ok-author-post")).toBe(true);
  });

  // ⚠️ PAGE-BOUNDARY COVERAGE — the keyset `+1`-sentinel/`nextCursor` path is
  // otherwise untested across the codebase's keyset queries. A fresh
  // viewer + fresh followed author isolate the count from every other case's
  // seed data (the `viewer`/`followed` pair above already carries posts from
  // the tests above).
  it("pages a 21-post feed as 20 + 1, in strict descending id order, with no gap or duplicate", async () => {
    const pagingViewer = await createVerifiedActor();
    const prolificAuthor = await createVerifiedActor();
    await seedFollow(pagingViewer.userId, prolificAuthor.userId);

    const seededIds: string[] = [];
    for (let i = 0; i < 21; i++) {
      seededIds.push(await seedPost(prolificAuthor.userId, `paging-post-${i}`, "published"));
    }

    const firstResponse = await getFeed(pagingViewer);
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as {
      posts: { id: string }[];
      nextCursor: string | null;
    };
    expect(firstBody.posts).toHaveLength(20);
    expect(firstBody.nextCursor).not.toBeNull();
    expect(firstBody.nextCursor).toBe(firstBody.posts[firstBody.posts.length - 1]!.id);

    const secondResponse = await getFeed(pagingViewer, firstBody.nextCursor!);
    expect(secondResponse.status).toBe(200);
    const secondBody = (await secondResponse.json()) as {
      posts: { id: string }[];
      nextCursor: string | null;
    };
    expect(secondBody.posts).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();

    const firstIds = firstBody.posts.map((p) => p.id);
    const secondIds = secondBody.posts.map((p) => p.id);

    // Disjoint.
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
    // Together cover exactly the 21 seeded ids — no duplicate, no gap.
    expect(new Set([...firstIds, ...secondIds])).toEqual(new Set(seededIds));
    expect(firstIds.length + secondIds.length).toBe(21);

    // Strictly descending id order within each page, and across the boundary.
    const allIdsInOrder = [...firstIds, ...secondIds];
    for (let i = 1; i < allIdsInOrder.length; i++) {
      expect(allIdsInOrder[i - 1]! > allIdsInOrder[i]!).toBe(true);
    }
  });
});

/**
 * ⚠️ WHAT THE EMPTY-FOLLOW SHORT-CIRCUIT IS WORTH. handleFeed's
 * `if (followeeIds.length === 0) return feedJson({ posts: [], nextCursor: null })`
 * (src/routes/feed.ts — "No client opened at all") is byte-identical in its
 * RESPONSE whether the guard fires or an empty `p.author_id = ANY('{}'::uuid[])`
 * posts query actually runs — so "returns an empty feed" above proves the
 * OUTPUT shape but would pass just as happily with the guard deleted. That is
 * the same trap test/purge-wiring.test.ts's header calls out: an assertion
 * that is satisfied by "nothing happened" proves nothing on its own unless
 * something in the same harness proves the harness CAN see "something
 * happened". The two cases below share one Proxy-based spy on
 * `env.HYPERDRIVE_FRESH` (property access = a Postgres client was opened) so
 * the NEGATIVE case is paired with a POSITIVE control: both viewers have a
 * followee-cache HIT already primed (so `getFolloweeIds` itself never touches
 * Postgres either way, isolating the spy to the posts query alone), and the
 * ONLY difference is whether that cached list is empty or not.
 */
describe("GET /feed — empty-follow short-circuit truly opens no Postgres client", () => {
  function spyHyperdrive(): { spied: Hyperdrive; opened: () => boolean } {
    let opened = false;
    const spied = new Proxy(env.HYPERDRIVE_FRESH, {
      get(target, prop, receiver) {
        opened = true;
        return Reflect.get(target, prop, receiver);
      },
    });
    return { spied, opened: () => opened };
  }

  it("POSITIVE control: a cached non-empty followee list DOES open a Postgres client (proves the spy can see one)", async () => {
    const reader = await createVerifiedActor();
    const author = await createVerifiedActor();
    await seedPost(author.userId, "spy-positive-post", "published");
    await env.FOLLOWEES.put(`followees:${reader.userId}`, JSON.stringify([author.userId]));

    const { spied, opened } = spyHyperdrive();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/feed", { headers: { Cookie: reader.cookie } }),
      { ...env, HYPERDRIVE_FRESH: spied },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(opened()).toBe(true);
  });

  it("NEGATIVE: a cached [] followee list opens NO Postgres client at all", async () => {
    const lonely = await createVerifiedActor();
    await env.FOLLOWEES.put(`followees:${lonely.userId}`, JSON.stringify([]));

    const { spied, opened } = spyHyperdrive();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/feed", { headers: { Cookie: lonely.cookie } }),
      { ...env, HYPERDRIVE_FRESH: spied },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { posts: unknown[]; nextCursor: string | null };
    expect(body.posts).toEqual([]);
    expect(opened()).toBe(false);
  });
});
