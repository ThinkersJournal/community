import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createPostRequest, createUnverifiedActor, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

/**
 * Task 1 (content-deletion + media-reclamation) — DELETE /posts/:id.
 *
 * ⚠️ THIS FILE IS ABOUT OWNER-AUTHORIZED HARD DELETION, mirroring
 * test/posts.test.ts (authorship/ownership) and test/purge-wiring.test.ts (the
 * purge spy) for its two harnesses. The auth-shaped assertions (no Origin ->
 * 403, no session -> 401) are covered structurally by test/route-protection.test.ts
 * the moment the route is registered in src/routes.ts.
 */

const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Drive the Worker with a stubbed WEB binding, capturing every purge call —
 * the same idiom as test/purge-wiring.test.ts's `fetchCapturingPurges`.
 */
async function fetchCapturingPurges(
  request: Request,
): Promise<{ response: Response; purges: string[][] }> {
  const purges: string[][] = [];
  const web = {
    fetch: async (_url: string, init: RequestInit) => {
      purges.push((JSON.parse(init.body as string) as { tags: string[] }).tags);
      return new Response(JSON.stringify({ purged: 1 }), { status: 200 });
    },
  };
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, WEB: web } as never, ctx);
  await waitOnExecutionContext(ctx);
  return { response, purges };
}

function mutatingHeaders(actor: Actor): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    Cookie: actor.cookie,
    "X-CSRF-Token": actor.csrfToken,
    "content-type": "application/json",
  };
}

function delRequest(path: string, actor: Actor): Request {
  return new Request(`https://api.test${path}`, {
    method: "DELETE",
    headers: mutatingHeaders(actor),
  });
}

function del(path: string, actor: Actor): Promise<Response> {
  return fetchWorker(delRequest(path, actor));
}

interface PostRow {
  id: string;
  author_id: string;
}

/** The row as the DATABASE holds it — `undefined` once the delete has landed. */
async function getPostRow(id: string): Promise<PostRow | undefined> {
  const ctx = createExecutionContext();
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<PostRow>("SELECT id, author_id FROM posts WHERE id = $1", [id]);
    return rows[0];
  });
  await waitOnExecutionContext(ctx);
  return row;
}

async function countComments(postId: string): Promise<number> {
  const ctx = createExecutionContext();
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM comments WHERE post_id = $1",
      [postId],
    );
    return rows[0]!.n;
  });
  await waitOnExecutionContext(ctx);
  return n;
}

async function countReactions(postId: string): Promise<number> {
  const ctx = createExecutionContext();
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM reactions WHERE post_id = $1",
      [postId],
    );
    return rows[0]!.n;
  });
  await waitOnExecutionContext(ctx);
  return n;
}

/** A published post owned by `actor`, carrying one tag — fails loudly if the create did not work. */
async function createPublishedWithTag(actor: Actor, tag: string): Promise<string> {
  const response = await fetchWorker(createPostRequest(actor, "published", { tags: [tag] }));
  if (response.status !== 201) {
    throw new Error(`fixture create failed: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

async function seedComment(commenter: Actor, postId: string): Promise<string> {
  const response = await fetchWorker(
    new Request("https://api.test/comments", {
      method: "POST",
      headers: mutatingHeaders(commenter),
      body: JSON.stringify({ postId, markdownSource: "a comment worth cascading" }),
    }),
  );
  if (response.status !== 201) {
    throw new Error(`fixture comment failed: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

async function seedReaction(reactor: Actor, postId: string): Promise<void> {
  const response = await fetchWorker(
    new Request("https://api.test/reactions", {
      method: "POST",
      headers: mutatingHeaders(reactor),
      body: JSON.stringify({ postId, kind: "insightful" }),
    }),
  );
  if (response.status !== 201) {
    throw new Error(`fixture reaction failed: ${response.status} ${await response.text()}`);
  }
}

/** A published, tagged post owned by `actor`, with a comment + reaction from `other` on it. */
async function publishPostWithCommentAndReaction(actor: Actor, other: Actor): Promise<string> {
  const postId = await createPublishedWithTag(actor, "delete-fixture");
  await seedComment(other, postId);
  await seedReaction(other, postId);
  return postId;
}

let actor: Actor;
let otherActor: Actor;

beforeAll(async () => {
  actor = await createVerifiedActor();
  otherActor = await createVerifiedActor();
});

afterAll(async () => {
  await deleteCreatedUsers();
});

describe("DELETE /posts/:id", () => {
  it("owner deletes their post → 200, post then 404s, comment+reaction gone (cascade)", async () => {
    const postId = await publishPostWithCommentAndReaction(actor, otherActor);
    // Sanity: the fixture actually seeded a comment + reaction before we assert they're gone.
    expect(await countComments(postId)).toBe(1);
    expect(await countReactions(postId)).toBe(1);

    const res = await del(`/posts/${postId}`, actor);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { username: string }).username).toBe(actor.username);

    // gone:
    expect(await getPostRow(postId)).toBeUndefined();
    expect(await countComments(postId)).toBe(0); // ON DELETE CASCADE
    expect(await countReactions(postId)).toBe(0); // ON DELETE CASCADE

    // the author's own GET now 404s too — there is nothing left to fetch.
    const getRes = await fetchWorker(
      new Request(`https://api.test/posts/${postId}`, { headers: { Cookie: actor.cookie } }),
    );
    expect(getRes.status).toBe(404);
  });

  it("purges post:/author:/listing/tag: on delete", async () => {
    const postId = await createPublishedWithTag(actor, "purge-tag");
    const { response, purges } = await fetchCapturingPurges(delRequest(`/posts/${postId}`, actor));
    expect(response.status).toBe(200);
    // ⚠️ ONE call, not one per tag — same purge-quota discipline as create/edit.
    expect(purges).toHaveLength(1);
    expect(purges[0]).toEqual([`post:${postId}`, `author:${actor.userId}`, "listing", "tag:purge-tag"]);
  });

  it("a non-owner delete → 404 and purges nothing", async () => {
    const postId = await createPublishedWithTag(actor, "non-owner-fixture");
    const { response, purges } = await fetchCapturingPurges(
      delRequest(`/posts/${postId}`, otherActor),
    );
    expect(response.status).toBe(404);
    expect(purges).toHaveLength(0);
    // The row must genuinely survive an attacker's delete attempt.
    expect(await getPostRow(postId)).not.toBeUndefined();
  });

  it("delete by an UNVERIFIED user → 403", async () => {
    const unverified = await createUnverifiedActor();
    const postId = await createPublishedWithTag(actor, "unverified-fixture");
    const res = await del(`/posts/${postId}`, unverified);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
    // The soft gate must reject before touching the row.
    expect(await getPostRow(postId)).not.toBeUndefined();
  });

  it("malformed id → 404 (not 500)", async () => {
    const res = await del(`/posts/not-a-uuid`, actor);
    expect(res.status).toBe(404);
  });
});
