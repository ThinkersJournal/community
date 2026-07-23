import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createUnverifiedActor, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Verified + handle chosen (mirrors follows.test.ts / comments.test.ts). */
async function onboardedActor(): Promise<Actor> {
  const actor = await createVerifiedActor();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE profiles SET username_chosen = true WHERE user_id = $1", [actor.userId]),
  );
  await waitOnExecutionContext(ctx);
  return actor;
}

function mutatingHeaders(actor: Actor): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    Cookie: actor.cookie,
    "X-CSRF-Token": actor.csrfToken,
    "content-type": "application/json",
  };
}

/** Insert a post row directly (status parameterized) and return its id. */
async function insertPost(authorId: string, status: "draft" | "published"): Promise<string> {
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 't', $2, 'b', $3, CASE WHEN $3 = 'published' THEN now() ELSE NULL END)
       RETURNING id`,
      [authorId, `r-${crypto.randomUUID()}`, status],
    );
    return rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return id;
}

/** Direct insert (write suite — the comment write route is Task 4's concern). */
async function insertComment(
  postId: string,
  authorId: string,
  parent?: { id: string; path: string; depth: number },
  deleted = false,
): Promise<{ id: string; path: string; depth: number }> {
  const depth = parent === undefined ? 0 : parent.depth + 1;
  const ctx = createExecutionContext();
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string; path: string }>(
      `WITH ids AS (SELECT uuidv7() AS id)
       INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown, deleted_at)
       SELECT ids.id, $1, $2, $3,
              CASE WHEN $4::text IS NULL THEN ids.id::text ELSE $4 || '/' || ids.id::text END,
              $5, $6, CASE WHEN $7 THEN now() ELSE NULL END
         FROM ids
       RETURNING id, path`,
      [postId, authorId, parent?.id ?? null, parent?.path ?? null, depth, deleted ? "" : "body", deleted],
    );
    return rows[0]!;
  });
  await waitOnExecutionContext(ctx);
  return { ...row, depth };
}

function react(
  actor: Actor,
  body: { postId?: string; commentId?: string; kind: string },
): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/reactions", {
      method: "POST",
      headers: mutatingHeaders(actor),
      body: JSON.stringify(body),
    }),
  );
}

function unreact(
  actor: Actor,
  target: { postId?: string; commentId?: string },
  kind: string,
): Promise<Response> {
  const q = new URLSearchParams({ kind });
  if (target.postId !== undefined) q.set("postId", target.postId);
  if (target.commentId !== undefined) q.set("commentId", target.commentId);
  return fetchWorker(
    new Request(`https://api.test/reactions?${q.toString()}`, {
      method: "DELETE",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
      },
    }),
  );
}

async function reactionCount(where: { postId?: string; commentId?: string }, kind: string): Promise<number> {
  const ctx = createExecutionContext();
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const col = where.postId !== undefined ? "post_id" : "comment_id";
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM reactions WHERE ${col} = $1 AND kind = $2`,
      [where.postId ?? where.commentId, kind],
    );
    return Number(rows[0]!.n);
  });
  await waitOnExecutionContext(ctx);
  return n;
}

let author: Actor;
let reader: Actor;
let postId: string;
beforeAll(async () => {
  author = await onboardedActor();
  reader = await onboardedActor();
  postId = await insertPost(author.userId, "published");
});
afterAll(deleteCreatedUsers);

describe("POST /reactions", () => {
  it("toggles on a post reaction idempotently (201, one row)", async () => {
    expect((await react(reader, { postId, kind: "insightful" })).status).toBe(201);
    expect((await react(reader, { postId, kind: "insightful" })).status).toBe(201);
    expect(await reactionCount({ postId }, "insightful")).toBe(1);
  });

  it("allows MULTIPLE tones from one user on one target (multi-toggle)", async () => {
    await react(reader, { postId, kind: "agree" });
    await react(reader, { postId, kind: "challenging" });
    expect(await reactionCount({ postId }, "agree")).toBe(1);
    expect(await reactionCount({ postId }, "challenging")).toBe(1);
  });

  it("reacts to a comment", async () => {
    const c = await insertComment(postId, author.userId);
    expect((await react(reader, { commentId: c.id, kind: "curious" })).status).toBe(201);
    expect(await reactionCount({ commentId: c.id }, "curious")).toBe(1);
  });

  it("400s INVALID_REACTION_KIND for an unknown kind", async () => {
    const response = await react(reader, { postId, kind: "love" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_REACTION_KIND");
  });

  it("400s INVALID_INPUT for zero or two targets", async () => {
    expect((await react(reader, { kind: "agree" })).status).toBe(400);
    const c = await insertComment(postId, author.userId);
    expect((await react(reader, { postId, commentId: c.id, kind: "agree" })).status).toBe(400);
  });

  it("404s a draft post and a nonexistent post (parity)", async () => {
    const draft = await insertPost(author.userId, "draft");
    expect((await react(reader, { postId: draft, kind: "agree" })).status).toBe(404);
    expect((await react(reader, { postId: crypto.randomUUID(), kind: "agree" })).status).toBe(404);
  });

  it("404s COMMENT_NOT_FOUND / 409s COMMENT_DELETED for comment targets", async () => {
    const missing = await react(reader, { commentId: crypto.randomUUID(), kind: "agree" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("COMMENT_NOT_FOUND");
    const c = await insertComment(postId, author.userId, undefined, true); // tombstoned
    const dead = await react(reader, { commentId: c.id, kind: "agree" });
    expect(dead.status).toBe(409);
    expect(((await dead.json()) as { code: string }).code).toBe("COMMENT_DELETED");
  });

  it("gates: 403 unverified, 409 no handle", async () => {
    const unverified = await createUnverifiedActor();
    expect((await react(unverified, { postId, kind: "agree" })).status).toBe(403);
    const noHandle = await createVerifiedActor();
    expect((await react(noHandle, { postId, kind: "agree" })).status).toBe(409);
  });
});

describe("DELETE /reactions", () => {
  it("toggles off (200) and is a 200 no-op when absent", async () => {
    await react(reader, { postId, kind: "curious" });
    expect((await unreact(reader, { postId }, "curious")).status).toBe(200);
    expect(await reactionCount({ postId }, "curious")).toBe(0);
    expect((await unreact(reader, { postId }, "curious")).status).toBe(200);
  });

  it("retracts from a since-tombstoned comment (no target-state validation)", async () => {
    const c = await insertComment(postId, author.userId);
    await react(reader, { commentId: c.id, kind: "agree" });
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (cl) =>
      cl.query("UPDATE comments SET deleted_at = now(), body_markdown = '' WHERE id = $1", [c.id]),
    );
    await waitOnExecutionContext(ctx);
    expect((await unreact(reader, { commentId: c.id }, "agree")).status).toBe(200);
    expect(await reactionCount({ commentId: c.id }, "agree")).toBe(0);
  });

  it("400s on bad kind / bad target shape", async () => {
    expect((await unreact(reader, { postId }, "love")).status).toBe(400);
    expect((await unreact(reader, {}, "agree")).status).toBe(400);
  });
});

function getPublicReactions(postId: string): Promise<Response> {
  return fetchWorker(new Request(`https://api.test/public/reactions?postId=${postId}`));
}

function getMine(actor: Actor, postId: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/reactions/mine?postId=${postId}`, {
      headers: { Cookie: actor.cookie },
    }),
  );
}

describe("GET /public/reactions", () => {
  it("zero-fills all four kinds for post and listed comments", async () => {
    const p = await insertPost(author.userId, "published");
    const c = await insertComment(p, author.userId);
    await react(reader, { postId: p, kind: "insightful" });
    await react(author, { postId: p, kind: "insightful" });
    await react(reader, { commentId: c.id, kind: "challenging" });
    const body = (await (await getPublicReactions(p)).json()) as {
      post: Record<string, number>;
      comments: Record<string, Record<string, number>>;
    };
    expect(body.post).toEqual({ insightful: 2, curious: 0, agree: 0, challenging: 0 });
    expect(body.comments[c.id]).toEqual({ insightful: 0, curious: 0, agree: 0, challenging: 1 });
  });

  it("404s draft/nonexistent posts and a missing postId", async () => {
    const draft = await insertPost(author.userId, "draft");
    expect((await getPublicReactions(draft)).status).toBe(404);
    expect((await getPublicReactions(crypto.randomUUID())).status).toBe(404);
    expect((await fetchWorker(new Request("https://api.test/public/reactions"))).status).toBe(404);
  });
});

describe("GET /reactions/mine", () => {
  it("returns ONLY the viewer's toggles, two-level", async () => {
    const p = await insertPost(author.userId, "published");
    const c = await insertComment(p, author.userId);
    await react(reader, { postId: p, kind: "agree" });
    await react(reader, { commentId: c.id, kind: "curious" });
    await react(author, { postId: p, kind: "challenging" }); // someone else's — must not appear
    const body = (await (await getMine(reader, p)).json()) as {
      post: string[];
      comments: Record<string, string[]>;
    };
    expect(body.post).toEqual(["agree"]);
    expect(body.comments[c.id]).toEqual(["curious"]);
  });

  it("401s LOGIN_REQUIRED with no session", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/reactions/mine?postId=${postId}`),
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("LOGIN_REQUIRED");
  });
});
