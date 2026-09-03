import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

/**
 * A verified actor (mirrors follows.test.ts's `onboardedActor`, kept unrenamed
 * for the same reason — see its comment there).
 */
async function onboardedActor(): Promise<Actor> {
  return createVerifiedActor();
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

/** Auto-hide a post directly (M4 Task 7). */
async function hidePost(id: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE posts SET hidden_at = now() WHERE id = $1", [id]));
  await waitOnExecutionContext(ctx);
}

/** Auto-hide a comment directly (M4 Task 7). */
async function hideComment(id: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE comments SET hidden_at = now() WHERE id = $1", [id]));
  await waitOnExecutionContext(ctx);
}

/** Insert a `blocks` row directly (Task 4's own route is not exercised here). */
async function insertBlock(blockerId: string, blockedId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)", [blockerId, blockedId]),
  );
  await waitOnExecutionContext(ctx);
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

  it("gates: 403 unverified; a verified reactor with no separate onboarding step can react immediately", async () => {
    const unverified = await createUnverifiedActor();
    expect((await react(unverified, { postId, kind: "agree" })).status).toBe(403);
    const noExtraStep = await createVerifiedActor();
    expect((await react(noExtraStep, { postId, kind: "agree" })).status).toBe(201);
  });
});

describe("block enforcement (M4)", () => {
  it("403s BLOCKED reacting to a post whose author has blocked the actor", async () => {
    const poster = await onboardedActor();
    const reactor = await onboardedActor();
    const p = await insertPost(poster.userId, "published");
    await insertBlock(poster.userId, reactor.userId);
    const response = await react(reactor, { postId: p, kind: "agree" });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("BLOCKED");
  });

  it("403s BLOCKED reacting to a comment whose author has blocked the actor", async () => {
    const poster = await onboardedActor();
    const commentAuthor = await onboardedActor();
    const reactor = await onboardedActor();
    const p = await insertPost(poster.userId, "published");
    const c = await insertComment(p, commentAuthor.userId);
    await insertBlock(commentAuthor.userId, reactor.userId);
    const response = await react(reactor, { commentId: c.id, kind: "agree" });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("BLOCKED");
  });

  it("a NON-blocked reactor still succeeds (guard against over-blocking)", async () => {
    const poster = await onboardedActor();
    const reactor = await onboardedActor();
    const p = await insertPost(poster.userId, "published");
    const response = await react(reactor, { postId: p, kind: "agree" });
    expect(response.status).toBe(201);
  });
});

describe("auto-hide filtering (M4 Task 7)", () => {
  it("404s reacting to an auto-HIDDEN post (parity with nonexistent), while a non-hidden post still 201s", async () => {
    const poster = await onboardedActor();
    const hidden = await insertPost(poster.userId, "published");
    await hidePost(hidden);
    expect((await react(reader, { postId: hidden, kind: "agree" })).status).toBe(404);
    // Control: a non-hidden post is still reactable.
    const visible = await insertPost(poster.userId, "published");
    expect((await react(reader, { postId: visible, kind: "agree" })).status).toBe(201);
  });

  it("404s COMMENT_NOT_FOUND reacting to an auto-HIDDEN comment, while a non-hidden comment still 201s", async () => {
    const poster = await onboardedActor();
    const p = await insertPost(poster.userId, "published");
    const hidden = await insertComment(p, poster.userId);
    await hideComment(hidden.id);
    const dead = await react(reader, { commentId: hidden.id, kind: "agree" });
    expect(dead.status).toBe(404);
    expect(((await dead.json()) as { code: string }).code).toBe("COMMENT_NOT_FOUND");
    // Control: a non-hidden comment on the same post is still reactable.
    const visible = await insertComment(p, poster.userId);
    expect((await react(reader, { commentId: visible.id, kind: "agree" })).status).toBe(201);
  });

  it("404s reacting to a comment whose POST is auto-hidden", async () => {
    const poster = await onboardedActor();
    const p = await insertPost(poster.userId, "published");
    const c = await insertComment(p, poster.userId);
    await hidePost(p);
    const dead = await react(reader, { commentId: c.id, kind: "agree" });
    expect(dead.status).toBe(404);
    expect(((await dead.json()) as { code: string }).code).toBe("COMMENT_NOT_FOUND");
  });

  it("404s public reaction counts for an auto-HIDDEN post (M4 Task 7)", async () => {
    const p = await insertPost(author.userId, "published");
    await hidePost(p);
    expect((await getPublicReactions(p)).status).toBe(404);
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

async function notifsFor(
  recipientId: string,
): Promise<Array<{ kind: string; actorId: string; reactionKind: string | null }>> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ kind: string; actor_id: string; reaction_kind: string | null }>(
      "SELECT kind, actor_id, reaction_kind FROM notifications WHERE recipient_id=$1 ORDER BY id",
      [recipientId],
    );
    return rows;
  });
  await waitOnExecutionContext(ctx);
  return rows.map((r) => ({ kind: r.kind, actorId: r.actor_id, reactionKind: r.reaction_kind }));
}

describe("reaction notifications (M2.3a)", () => {
  it("a post reaction notifies the post author with the tone; re-reacting same tone does not duplicate", async () => {
    const posterActor = await onboardedActor();
    const p = await insertPost(posterActor.userId, "published");
    await react(reader, { postId: p, kind: "insightful" });
    await react(reader, { postId: p, kind: "insightful" }); // idempotent
    const n = await notifsFor(posterActor.userId);
    expect(n).toEqual([{ kind: "post_reaction", actorId: reader.userId, reactionKind: "insightful" }]);
    // a different tone from the same actor IS a new notification
    await react(reader, { postId: p, kind: "agree" });
    expect((await notifsFor(posterActor.userId)).length).toBe(2);
  });

  it("a comment reaction notifies the comment author", async () => {
    const commentAuthor = await onboardedActor();
    const p = await insertPost(commentAuthor.userId, "published");
    const c = await insertComment(p, commentAuthor.userId);
    await react(reader, { commentId: c.id, kind: "curious" });
    expect(await notifsFor(commentAuthor.userId)).toEqual([
      { kind: "comment_reaction", actorId: reader.userId, reactionKind: "curious" },
    ]);
  });

  it("reacting to your OWN post/comment notifies no one", async () => {
    const p = await insertPost(reader.userId, "published");
    await react(reader, { postId: p, kind: "agree" });
    expect(await notifsFor(reader.userId)).toEqual([]);
  });
});

describe("reaction notify push (M2.3b)", () => {
  function spyingNotify(pushed: Array<{ id: string; kind: string }>): {
    getByName: (id: string) => { push: (kind: string) => void; fetch: () => Promise<Response> };
  } {
    return {
      getByName: (id: string) => ({
        push: (kind: string) => {
          pushed.push({ id, kind });
        },
        fetch: async () => new Response(),
      }),
    };
  }

  it("pushes a realtime nudge to the recipient's NotifyDO after a reaction", async () => {
    const pushed: Array<{ id: string; kind: string }> = [];
    const posterActor = await onboardedActor();
    const reactorActor = await onboardedActor();
    const p = await insertPost(posterActor.userId, "published");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/reactions", {
        method: "POST",
        headers: mutatingHeaders(reactorActor),
        body: JSON.stringify({ postId: p, kind: "agree" }),
      }),
      { ...env, NOTIFY: spyingNotify(pushed) } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    expect(pushed).toEqual([{ id: posterActor.userId, kind: "notification" }]);
  });

  it("reacting to your own post/comment pushes nothing (self-suppression)", async () => {
    const pushed: Array<{ id: string; kind: string }> = [];
    const posterActor = await onboardedActor();
    const p = await insertPost(posterActor.userId, "published");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/reactions", {
        method: "POST",
        headers: mutatingHeaders(posterActor),
        body: JSON.stringify({ postId: p, kind: "agree" }),
      }),
      { ...env, NOTIFY: spyingNotify(pushed) } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    expect(pushed).toEqual([]);
  });

  it("a repeat same-tone reaction pushes EXACTLY ONCE (live-channel anti-spam)", async () => {
    // Finding 2 (M2.3b fix wave): mirrors M2.3a's "re-reacting same tone does
    // not duplicate" for the DB row — the repeat reaction's insert conflicts
    // (rowCount 0), so notify()'s rowCount gate means the SECOND identical
    // reaction pushes nothing, even though the write itself still 201s.
    const pushed: Array<{ id: string; kind: string }> = [];
    const posterActor = await onboardedActor();
    const reactorActor = await onboardedActor();
    const p = await insertPost(posterActor.userId, "published");
    const notifyEnv = { ...env, NOTIFY: spyingNotify(pushed) } as never;
    const body = JSON.stringify({ postId: p, kind: "agree" });

    const ctx1 = createExecutionContext();
    const r1 = await worker.fetch(
      new Request("https://api.test/reactions", {
        method: "POST",
        headers: mutatingHeaders(reactorActor),
        body,
      }),
      notifyEnv,
      ctx1,
    );
    await waitOnExecutionContext(ctx1);
    expect(r1.status).toBe(201);

    const ctx2 = createExecutionContext();
    const r2 = await worker.fetch(
      new Request("https://api.test/reactions", {
        method: "POST",
        headers: mutatingHeaders(reactorActor),
        body,
      }),
      notifyEnv,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    expect(r2.status).toBe(201);

    expect(pushed).toEqual([{ id: posterActor.userId, kind: "notification" }]);
  });

  it("a push failure does not fail the reaction write", async () => {
    const notify = {
      getByName: () => ({
        push: () => {
          throw new Error("DO unavailable");
        },
        fetch: async () => new Response(),
      }),
    };
    const posterActor = await onboardedActor();
    const reactorActor = await onboardedActor();
    const p = await insertPost(posterActor.userId, "published");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/reactions", {
        method: "POST",
        headers: mutatingHeaders(reactorActor),
        body: JSON.stringify({ postId: p, kind: "agree" }),
      }),
      { ...env, NOTIFY: notify } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    expect(error).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("reaction post-live push (M2.3b-live)", () => {
  function spyingPostLive(pushed: Array<{ id: string; kind: string }>): {
    getByName: (id: string) => { push: (kind: string) => void };
  } {
    return {
      getByName: (id: string) => ({
        push: (kind: string) => {
          pushed.push({ id, kind });
        },
      }),
    };
  }

  it("an add-reaction on a POST pushes a reaction nudge to that post's channel", async () => {
    const pushed: Array<{ id: string; kind: string }> = [];
    const posterActor = await onboardedActor();
    const reactorActor = await onboardedActor();
    const p = await insertPost(posterActor.userId, "published");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/reactions", {
        method: "POST",
        headers: mutatingHeaders(reactorActor),
        body: JSON.stringify({ postId: p, kind: "agree" }),
      }),
      { ...env, POST_LIVE: spyingPostLive(pushed) } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    expect(pushed).toEqual([{ id: p, kind: "reaction" }]);
  });

  it("an add-reaction on a COMMENT pushes to the comment's POST, not the comment id", async () => {
    const pushed: Array<{ id: string; kind: string }> = [];
    const posterActor = await onboardedActor();
    const reactorActor = await onboardedActor();
    const p = await insertPost(posterActor.userId, "published");
    const c = await insertComment(p, posterActor.userId);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/reactions", {
        method: "POST",
        headers: mutatingHeaders(reactorActor),
        body: JSON.stringify({ commentId: c.id, kind: "curious" }),
      }),
      { ...env, POST_LIVE: spyingPostLive(pushed) } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    expect(pushed).toEqual([{ id: p, kind: "reaction" }]);
  });

  it("a duplicate add (ON CONFLICT no-op) pushes nothing", async () => {
    const pushed: Array<{ id: string; kind: string }> = [];
    const posterActor = await onboardedActor();
    const reactorActor = await onboardedActor();
    const p = await insertPost(posterActor.userId, "published");
    await react(reactorActor, { postId: p, kind: "agree" });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/reactions", {
        method: "POST",
        headers: mutatingHeaders(reactorActor),
        body: JSON.stringify({ postId: p, kind: "agree" }),
      }),
      { ...env, POST_LIVE: spyingPostLive(pushed) } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    expect(pushed).toEqual([]);
  });

  it("removing a POST reaction pushes a reaction nudge to that post's channel", async () => {
    const pushed: Array<{ id: string; kind: string }> = [];
    const posterActor = await onboardedActor();
    const reactorActor = await onboardedActor();
    const p = await insertPost(posterActor.userId, "published");
    await react(reactorActor, { postId: p, kind: "agree" });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://api.test/reactions?${new URLSearchParams({ kind: "agree", postId: p }).toString()}`, {
        method: "DELETE",
        headers: {
          Origin: ALLOWED_ORIGIN,
          Cookie: reactorActor.cookie,
          "X-CSRF-Token": reactorActor.csrfToken,
        },
      }),
      { ...env, POST_LIVE: spyingPostLive(pushed) } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(pushed).toEqual([{ id: p, kind: "reaction" }]);
  });

  it("removing a COMMENT reaction pushes to the comment's POST, not the comment id", async () => {
    const pushed: Array<{ id: string; kind: string }> = [];
    const posterActor = await onboardedActor();
    const reactorActor = await onboardedActor();
    const p = await insertPost(posterActor.userId, "published");
    const c = await insertComment(p, posterActor.userId);
    await react(reactorActor, { commentId: c.id, kind: "curious" });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://api.test/reactions?${new URLSearchParams({ kind: "curious", commentId: c.id }).toString()}`, {
        method: "DELETE",
        headers: {
          Origin: ALLOWED_ORIGIN,
          Cookie: reactorActor.cookie,
          "X-CSRF-Token": reactorActor.csrfToken,
        },
      }),
      { ...env, POST_LIVE: spyingPostLive(pushed) } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(pushed).toEqual([{ id: p, kind: "reaction" }]);
  });

  it("removing an absent reaction (no-op) pushes nothing", async () => {
    const pushed: Array<{ id: string; kind: string }> = [];
    const posterActor = await onboardedActor();
    const reactorActor = await onboardedActor();
    const p = await insertPost(posterActor.userId, "published");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://api.test/reactions?${new URLSearchParams({ kind: "agree", postId: p }).toString()}`, {
        method: "DELETE",
        headers: {
          Origin: ALLOWED_ORIGIN,
          Cookie: reactorActor.cookie,
          "X-CSRF-Token": reactorActor.csrfToken,
        },
      }),
      { ...env, POST_LIVE: spyingPostLive(pushed) } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(pushed).toEqual([]);
  });
});
