import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor } from "./actor";

import type { Actor } from "./actor";

/**
 * #58 (the non-policy half) — an author may not EDIT content while a
 * moderator, or an auto-hide pending review, controls its visibility.
 * Otherwise the moderator rules on a version different from the one reported.
 *
 * "Moderation-hidden" is NOT re-derived here or in the routes: a post is
 * frozen exactly when author-hide.ts's own gate says the author could not
 * hide/unhide it themselves (hidden, and the latest VISIBILITY action is not
 * `author_hide`). A comment has no author-hide, so any `hidden_at` on it is
 * moderation's (auto-hide.ts / decide.ts).
 *
 * The author's OWN self-hide stays editable — the positive controls below.
 * Delete, and the content snapshot, are deliberately NOT here: they wait on
 * CireSnave's ruling (board item 77).
 */

const ALLOWED_ORIGIN = "http://localhost:8787";

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, WEB: { fetch: async () => new Response("{}", { status: 200 }) } } as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function authed(actor: Actor, url: string, method: string, body?: unknown): Promise<Response> {
  return fetchWorker(
    new Request(url, {
      method,
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function editPost(actor: Actor, postId: string, markdownSource: string): Promise<Response> {
  return authed(actor, `https://api.test/posts/${postId}`, "PATCH", {
    title: "test",
    markdownSource,
    status: "published",
    tags: [],
  });
}
function editComment(actor: Actor, commentId: string, markdownSource: string): Promise<Response> {
  return authed(actor, `https://api.test/comments/${commentId}`, "PATCH", { markdownSource });
}

async function seedPost(actor: Actor): Promise<string> {
  return ctxRun(async (c) => {
    const slug = "test-" + crypto.randomUUID().slice(0, 8);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 'test', $2, 'original', 'published', now()) RETURNING id`,
      [actor.userId, slug],
    );
    return rows[0]!.id;
  });
}

async function seedComment(actor: Actor, postId: string): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `WITH ids AS (SELECT uuidv7() AS id)
       INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown)
       SELECT ids.id, $1, $2, NULL, ids.id::text, 0, 'original'
         FROM ids
       RETURNING id`,
      [postId, actor.userId],
    );
    return rows[0]!.id;
  });
}

/** An auto-hide pending review: `hidden_at` set, no visibility action logged yet. */
async function autoHidePost(postId: string): Promise<void> {
  await ctxRun((c) => c.query(`UPDATE posts SET hidden_at = now() WHERE id = $1`, [postId]));
}
async function autoHideComment(commentId: string): Promise<void> {
  await ctxRun((c) => c.query(`UPDATE comments SET hidden_at = now() WHERE id = $1`, [commentId]));
}

async function logAction(postId: string, action: string): Promise<void> {
  await ctxRun((c) =>
    c.query(
      `INSERT INTO moderation_actions (actor_admin, action, post_id, reason) VALUES ('mod@example.test', $2, $1, 'r')`,
      [postId, action],
    ),
  );
}

async function moderatorDecides(postId: string, action: "content_keep_hidden" | "content_remove"): Promise<void> {
  await autoHidePost(postId);
  await logAction(postId, action);
}

async function postBody(postId: string): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ m: string }>(`SELECT markdown_source AS m FROM posts WHERE id = $1`, [postId]);
    return rows[0]!.m;
  });
}
async function commentBody(commentId: string): Promise<{ body: string; edited: boolean }> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ body: string; edited: boolean }>(
      `SELECT body_markdown AS body, (edited_at IS NOT NULL) AS edited FROM comments WHERE id = $1`,
      [commentId],
    );
    return rows[0]!;
  });
}

async function codeOf(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PATCH /posts/:id — frozen while moderation controls visibility (#58)", () => {
  it("control: a visible post is editable", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);
    expect((await editPost(author, postId, "edited")).status).toBe(200);
    expect(await postBody(postId)).toBe("edited");
  });

  it("refuses an auto-hidden post pending review (403 POST_UNDER_MODERATION), content unchanged", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);
    await autoHidePost(postId);

    const res = await editPost(author, postId, "edited");
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("POST_UNDER_MODERATION");
    expect(await postBody(postId)).toBe("original");
  });

  it.each(["content_keep_hidden", "content_remove"] as const)(
    "refuses a post after a moderator's %s, content unchanged",
    async (action) => {
      const author = await createVerifiedActor();
      const postId = await seedPost(author);
      await moderatorDecides(postId, action);

      const res = await editPost(author, postId, "edited");
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("POST_UNDER_MODERATION");
      expect(await postBody(postId)).toBe("original");
    },
  );

  it("positive control: the author's OWN self-hide stays editable", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);
    expect((await authed(author, `https://api.test/posts/${postId}/hide`, "POST")).status).toBe(200);

    expect((await editPost(author, postId, "edited")).status).toBe(200);
    expect(await postBody(postId)).toBe("edited");
  });

  it("a non-visibility row (media_access) after a self-hide does not freeze it — same filter as author-hide.ts", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);
    expect((await authed(author, `https://api.test/posts/${postId}/hide`, "POST")).status).toBe(200);
    await logAction(postId, "media_access");

    expect((await editPost(author, postId, "edited")).status).toBe(200);
    expect(await postBody(postId)).toBe("edited");
  });

  it("a moderator's keep_hidden AFTER a self-hide freezes it", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);
    expect((await authed(author, `https://api.test/posts/${postId}/hide`, "POST")).status).toBe(200);
    await logAction(postId, "content_keep_hidden");

    const res = await editPost(author, postId, "edited");
    expect(res.status).toBe(403);
    expect(await postBody(postId)).toBe("original");
  });

  it("a moderator's restore lifts the freeze", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);
    await moderatorDecides(postId, "content_keep_hidden");
    await ctxRun((c) => c.query(`UPDATE posts SET hidden_at = NULL WHERE id = $1`, [postId]));
    await logAction(postId, "content_restore");

    expect((await editPost(author, postId, "edited")).status).toBe(200);
  });

  it("a stranger editing a moderation-hidden post gets 404, not the 403 (no existence/state leak)", async () => {
    const author = await createVerifiedActor();
    const stranger = await createVerifiedActor();
    const postId = await seedPost(author);
    await autoHidePost(postId);

    expect((await editPost(stranger, postId, "hijack")).status).toBe(404);
    expect(await postBody(postId)).toBe("original");
  });
});

describe("PATCH /comments/:id — frozen while hidden (#58)", () => {
  it("control: a visible comment is editable", async () => {
    const author = await createVerifiedActor();
    const commentId = await seedComment(author, await seedPost(author));
    expect((await editComment(author, commentId, "edited")).status).toBe(200);
    expect(await commentBody(commentId)).toEqual({ body: "edited", edited: true });
  });

  it("refuses a hidden comment (403 COMMENT_UNDER_MODERATION), body and edited_at unchanged", async () => {
    const author = await createVerifiedActor();
    const commentId = await seedComment(author, await seedPost(author));
    await autoHideComment(commentId);

    const res = await editComment(author, commentId, "edited");
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("COMMENT_UNDER_MODERATION");
    expect(await commentBody(commentId)).toEqual({ body: "original", edited: false });
  });

  it("refuses an identical-body resubmit on a hidden comment too (not a 200 no-op)", async () => {
    const author = await createVerifiedActor();
    const commentId = await seedComment(author, await seedPost(author));
    await autoHideComment(commentId);

    const res = await editComment(author, commentId, "original");
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("COMMENT_UNDER_MODERATION");
  });

  it("a stranger editing a hidden comment gets 404 COMMENT_NOT_FOUND (no state leak)", async () => {
    const author = await createVerifiedActor();
    const stranger = await createVerifiedActor();
    const commentId = await seedComment(author, await seedPost(author));
    await autoHideComment(commentId);

    const res = await editComment(stranger, commentId, "hijack");
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("COMMENT_NOT_FOUND");
    expect(await commentBody(commentId)).toEqual({ body: "original", edited: false });
  });
});
