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

/** Verified + handle chosen (mirrors follows.test.ts). */
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
      [authorId, `c-${crypto.randomUUID()}`, status],
    );
    return rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return id;
}

function createComment(
  actor: Actor,
  body: { postId: string; parentId?: string; markdownSource: string },
): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/comments", {
      method: "POST",
      headers: mutatingHeaders(actor),
      body: JSON.stringify(body),
    }),
  );
}

function updateComment(actor: Actor, id: string, markdownSource: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/comments/${id}`, {
      method: "PATCH",
      headers: mutatingHeaders(actor),
      body: JSON.stringify({ markdownSource }),
    }),
  );
}

function deleteComment(actor: Actor, id: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/comments/${id}`, {
      method: "DELETE",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
      },
    }),
  );
}

async function tombstoned(id: string): Promise<{ deleted: boolean; body: string } | null> {
  const ctx = createExecutionContext();
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ deleted: boolean; body: string }>(
      `SELECT (deleted_at IS NOT NULL) AS deleted, body_markdown AS body
         FROM comments WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  });
  await waitOnExecutionContext(ctx);
  return row;
}

async function commentRow(id: string): Promise<{ path: string; depth: number } | null> {
  const ctx = createExecutionContext();
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ path: string; depth: number }>(
      "SELECT path, depth FROM comments WHERE id = $1",
      [id],
    );
    return rows[0] ?? null;
  });
  await waitOnExecutionContext(ctx);
  return row;
}

let author: Actor;
let reader: Actor;
let postId: string;
beforeAll(async () => {
  author = await onboardedActor();
  reader = await onboardedActor();
  postId = await insertPost(author.userId, "published");
});

// ⚠️ BUDGET: `reader` above already spends EXACTLY 10/10 of COMMENT_LIMITER's
// 10-per-60s window across "POST /comments" — zero slack. `author` also has
// existing writes. Task 4's PATCH/DELETE cases therefore use their OWN fresh
// actors (never `reader`/`author`) for every `createComment(...)` call, so
// they cannot push either actor's window over the limit and flake this file.
// `editor` plays the "reader" role (writes/owns comments); `modAuthor` plays
// the "author" role (owns `modPostId`, exercising decision-7 moderation and
// the PATCH ownership-leak case).
//
// ⚠️ PATCH/DELETE NOW ALSO SPEND COMMENT_LIMITER (milestone fix wave: closing
// the unbounded-purge DoS meant giving handleUpdateComment/handleDeleteComment
// the same `enforceRateLimit(COMMENT_LIMITER, comment:${userId})` gate as
// create). Tallied per actor across this whole file (create+patch+delete
// combined, since they share one key/window):
//   `editor`   — PATCH block only: 7 ops (create/patch/delete mixed).
//   `modAuthor`— PATCH block hijack-patch (1) + DELETE block create+delete (2) = 3 ops.
// That left NO headroom for the DELETE block's own create+delete traffic (8
// more ops) on top of `editor`'s 7 — 15 total would blow the 10/60s window.
// So the DELETE describe block below uses a THIRD fresh actor, `deleter`
// (8 ops, plays the exact same "comment author" role `editor` used to play
// there), instead of reusing `editor`.
let editor: Actor;
let modAuthor: Actor;
let deleter: Actor;
let modPostId: string;
beforeAll(async () => {
  editor = await onboardedActor();
  modAuthor = await onboardedActor();
  deleter = await onboardedActor();
  modPostId = await insertPost(modAuthor.userId, "published");
});

afterAll(deleteCreatedUsers);

describe("POST /comments", () => {
  it("creates a top-level comment (depth 0, path = own id) and 201s", async () => {
    const response = await createComment(reader, { postId, markdownSource: "first!" });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const row = await commentRow(id);
    expect(row).toEqual({ path: id, depth: 0 });
  });

  it("creates a nested reply (depth+1, path = parent/child)", async () => {
    const top = await createComment(reader, { postId, markdownSource: "top" });
    const { id: parentId } = (await top.json()) as { id: string };
    const reply = await createComment(author, { postId, parentId, markdownSource: "re" });
    expect(reply.status).toBe(201);
    const { id } = (await reply.json()) as { id: string };
    expect(await commentRow(id)).toEqual({ path: `${parentId}/${id}`, depth: 1 });
  });

  it("404s a DRAFT post exactly like a nonexistent one (parity)", async () => {
    const draftId = await insertPost(author.userId, "draft");
    const onDraft = await createComment(reader, { postId: draftId, markdownSource: "x" });
    const onMissing = await createComment(reader, {
      postId: crypto.randomUUID(),
      markdownSource: "x",
    });
    expect(onDraft.status).toBe(404);
    expect(onMissing.status).toBe(404);
    expect(((await onDraft.json()) as { code: string }).code).toBe(
      ((await onMissing.json()) as { code: string }).code,
    );
  });

  it("404s COMMENT_NOT_FOUND for a parent from a DIFFERENT post", async () => {
    const otherPost = await insertPost(author.userId, "published");
    const other = await createComment(reader, { postId: otherPost, markdownSource: "elsewhere" });
    const { id: foreignParent } = (await other.json()) as { id: string };
    const response = await createComment(reader, {
      postId,
      parentId: foreignParent,
      markdownSource: "x",
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("COMMENT_NOT_FOUND");
  });

  it("409s COMMENT_DELETED replying to a tombstone", async () => {
    const top = await createComment(reader, { postId, markdownSource: "doomed" });
    const { id: parentId } = (await top.json()) as { id: string };
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("UPDATE comments SET deleted_at = now(), body_markdown = '' WHERE id = $1", [parentId]),
    );
    await waitOnExecutionContext(ctx);
    const response = await createComment(reader, { postId, parentId, markdownSource: "x" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("COMMENT_DELETED");
  });

  it("409s COMMENT_DEPTH_EXCEEDED replying at the cap", async () => {
    // Own onboardedActor: this case alone makes 10 comment writes, and
    // COMMENT_LIMITER is 10/60s — sharing `reader`'s budget with the rest of
    // this suite would flake it.
    const depthActor = await onboardedActor();
    let parentId: string | undefined;
    for (let d = 0; d <= 8; d++) {
      const r = await createComment(depthActor, { postId, parentId, markdownSource: `d${d}` });
      expect(r.status).toBe(201);
      parentId = ((await r.json()) as { id: string }).id;
    }
    const over = await createComment(depthActor, { postId, parentId, markdownSource: "d9" });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { code: string }).code).toBe("COMMENT_DEPTH_EXCEEDED");
  });

  it("403s EMAIL_NOT_VERIFIED for an unverified commenter", async () => {
    const unverified = await createUnverifiedActor();
    const response = await createComment(unverified, { postId, markdownSource: "x" });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("409s USERNAME_REQUIRED for a verified commenter with no handle", async () => {
    const noHandle = await createVerifiedActor();
    const response = await createComment(noHandle, { postId, markdownSource: "x" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("USERNAME_REQUIRED");
  });

  it("400s INVALID_INPUT for an empty body and an over-cap body", async () => {
    const empty = await createComment(reader, { postId, markdownSource: "" });
    expect(empty.status).toBe(400);
    const over = await createComment(reader, { postId, markdownSource: "a".repeat(10_001) });
    expect(over.status).toBe(400);
  });
});

describe("PATCH /comments/:id", () => {
  it("edits own comment, sets edited_at, 200s", async () => {
    const created = await createComment(editor, { postId: modPostId, markdownSource: "v1" });
    const { id } = (await created.json()) as { id: string };
    const response = await updateComment(editor, id, "v2");
    expect(response.status).toBe(200);
    const ctx = createExecutionContext();
    const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ body: string; edited: boolean }>(
        `SELECT body_markdown AS body, (edited_at IS NOT NULL) AS edited
           FROM comments WHERE id = $1`,
        [id],
      );
      return rows[0]!;
    });
    await waitOnExecutionContext(ctx);
    expect(row).toEqual({ body: "v2", edited: true });
  });

  it("404s COMMENT_NOT_FOUND editing someone ELSE'S comment (no ownership leak)", async () => {
    const created = await createComment(editor, { postId: modPostId, markdownSource: "mine" });
    const { id } = (await created.json()) as { id: string };
    const response = await updateComment(modAuthor, id, "hijack"); // author of the POST, not the comment
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("COMMENT_NOT_FOUND");
  });

  it("404s editing a tombstoned comment", async () => {
    const created = await createComment(editor, { postId: modPostId, markdownSource: "bye" });
    const { id } = (await created.json()) as { id: string };
    await deleteComment(editor, id);
    const response = await updateComment(editor, id, "necro");
    expect(response.status).toBe(404);
  });

  it("400s INVALID_INPUT for a non-uuid id", async () => {
    const response = await updateComment(editor, "not-a-uuid", "x");
    expect(response.status).toBe(400);
  });

  // Milestone fix wave: PATCH now shares COMMENT_LIMITER with create/delete —
  // proves the unbounded-purge DoS is closed. DEDICATED fresh actor (never
  // `editor`/`modAuthor`/`deleter`) so this loop's own budget burn cannot
  // pollute any other test in this file.
  it("throttles rapid PATCHes on the caller's own comment (429 RATE_LIMITED)", async () => {
    const spammer = await onboardedActor();
    const created = await createComment(spammer, { postId: modPostId, markdownSource: "v0" });
    const { id } = (await created.json()) as { id: string };

    let sawRateLimited = false;
    for (let i = 0; i < 12 && !sawRateLimited; i++) {
      const response = await updateComment(spammer, id, `v${i}`);
      if (response.status === 429) {
        expect(((await response.json()) as { code: string }).code).toBe("RATE_LIMITED");
        sawRateLimited = true;
      } else {
        expect(response.status).toBe(200);
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});

describe("DELETE /comments/:id", () => {
  it("comment author tombstones own comment: body emptied, row + children remain", async () => {
    const top = await createComment(deleter, { postId: modPostId, markdownSource: "parent text" });
    const { id: parentId } = (await top.json()) as { id: string };
    const child = await createComment(modAuthor, {
      postId: modPostId,
      parentId,
      markdownSource: "child",
    });
    const { id: childId } = (await child.json()) as { id: string };

    const response = await deleteComment(deleter, parentId);
    expect(response.status).toBe(200);
    expect(await tombstoned(parentId)).toEqual({ deleted: true, body: "" });
    // The child SURVIVES — tombstone, not row delete.
    expect(await tombstoned(childId)).toEqual({ deleted: false, body: "child" });
  });

  it("POST AUTHOR may tombstone another user's comment on their post (decision 7)", async () => {
    const created = await createComment(deleter, {
      postId: modPostId,
      markdownSource: "on author's post",
    });
    const { id } = (await created.json()) as { id: string };
    const response = await deleteComment(modAuthor, id); // modAuthor owns the POST
    expect(response.status).toBe(200);
    expect(await tombstoned(id)).toEqual({ deleted: true, body: "" });
  });

  it("a THIRD PARTY (neither comment nor post author) gets 404", async () => {
    const third = await onboardedActor();
    const created = await createComment(deleter, { postId: modPostId, markdownSource: "x" });
    const { id } = (await created.json()) as { id: string };
    const response = await deleteComment(third, id);
    expect(response.status).toBe(404);
    expect(await tombstoned(id)).toEqual({ deleted: false, body: "x" });
  });

  it("is idempotent: deleting an already-tombstoned comment 200s", async () => {
    const created = await createComment(deleter, { postId: modPostId, markdownSource: "x" });
    const { id } = (await created.json()) as { id: string };
    await deleteComment(deleter, id);
    const again = await deleteComment(deleter, id);
    expect(again.status).toBe(200);
  });

  it("400s INVALID_INPUT for a non-uuid id", async () => {
    const response = await deleteComment(deleter, "nope");
    expect(response.status).toBe(400);
  });
});

async function notifsFor(
  recipientId: string,
): Promise<Array<{ kind: string; actorId: string; commentId: string | null }>> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ kind: string; actor_id: string; comment_id: string | null }>(
      "SELECT kind, actor_id, comment_id FROM notifications WHERE recipient_id=$1 ORDER BY id",
      [recipientId],
    );
    return rows;
  });
  await waitOnExecutionContext(ctx);
  return rows.map((r) => ({ kind: r.kind, actorId: r.actor_id, commentId: r.comment_id }));
}

describe("comment notifications (M2.3a)", () => {
  it("a top-level comment notifies the POST author with the new comment id", async () => {
    const poster = await onboardedActor();
    const commenter = await onboardedActor();
    const p = await insertPost(poster.userId, "published");
    const r = await createComment(commenter, { postId: p, markdownSource: "hi" });
    const newId = ((await r.json()) as { id: string }).id;
    expect(await notifsFor(poster.userId)).toEqual([
      { kind: "post_comment", actorId: commenter.userId, commentId: newId },
    ]);
  });

  it("a self-comment on your own post notifies no one", async () => {
    const poster = await onboardedActor();
    const p = await insertPost(poster.userId, "published");
    await createComment(poster, { postId: p, markdownSource: "mine" });
    expect(await notifsFor(poster.userId)).toEqual([]);
  });

  it("a reply notifies the PARENT commenter (not the post author), with the reply id", async () => {
    const poster = await onboardedActor();
    const parentAuthor = await onboardedActor();
    const replier = await onboardedActor();
    const p = await insertPost(poster.userId, "published");
    const top = await createComment(parentAuthor, { postId: p, markdownSource: "top" });
    const parentId = ((await top.json()) as { id: string }).id;
    const reply = await createComment(replier, { postId: p, parentId, markdownSource: "re" });
    const replyId = ((await reply.json()) as { id: string }).id;
    // parentAuthor gets the reply notification…
    expect(await notifsFor(parentAuthor.userId)).toEqual([
      { kind: "comment_reply", actorId: replier.userId, commentId: replyId },
    ]);
    // …and the post author gets ONLY the top-level comment, not the deep reply.
    expect(await notifsFor(poster.userId)).toEqual([
      { kind: "post_comment", actorId: parentAuthor.userId, commentId: parentId },
    ]);
  });
});
