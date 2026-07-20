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
    await seedPost(followed.userId, "followed-published", "published");
    const response = await getFeed(viewer);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { posts: { username: string; title: string }[] };
    expect(body.posts.some((p) => p.username === followed.username)).toBe(true);
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

  it("401s without a session", async () => {
    const response = await fetchWorker(new Request("https://api.test/feed"));
    expect(response.status).toBe(401);
  });

  it("400s on a malformed cursor", async () => {
    const response = await getFeed(viewer, "not-a-uuid");
    expect(response.status).toBe(400);
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
