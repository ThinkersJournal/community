import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor } from "./actor";

import type { Actor } from "./actor";

/**
 * `POST /posts/:id/hide` / `POST /posts/:id/unhide` — the author's OWN
 * self-hide (#61 follow-up, CireSnave's ruling on #26).
 *
 * The auth-spine assertions (no Origin -> 403, no session -> 401) are covered
 * structurally by test/route-protection.test.ts. This file is about the
 * ownership predicate and the "only the author's OWN hide is reversible by
 * them" gate — src/moderation/author-hide.ts's actual reason for existing.
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

function hide(actor: Actor, postId: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/posts/${postId}/hide`, {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken },
    }),
  );
}
function unhide(actor: Actor, postId: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/posts/${postId}/unhide`, {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken },
    }),
  );
}

async function seedPost(actor: Actor, markdown = "test"): Promise<string> {
  return ctxRun(async (c) => {
    const slug = "test-" + crypto.randomUUID().slice(0, 8);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 'test', $2, $3, 'published', now()) RETURNING id`,
      [actor.userId, slug, markdown],
    );
    return rows[0]!.id;
  });
}

async function autoHide(postId: string): Promise<void> {
  await ctxRun((c) => c.query(`UPDATE posts SET hidden_at = now() WHERE id = $1`, [postId]));
}

async function moderatorKeepHidden(postId: string): Promise<void> {
  await ctxRun(async (c) => {
    await c.query(`UPDATE posts SET hidden_at = now() WHERE id = $1`, [postId]);
    await c.query(
      `INSERT INTO moderation_actions (actor_admin, action, post_id, reason) VALUES ('mod@example.test', 'content_keep_hidden', $1, 'r')`,
      [postId],
    );
  });
}

async function hiddenAtOf(postId: string): Promise<Date | null> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ hidden_at: Date | null }>(`SELECT hidden_at FROM posts WHERE id = $1`, [postId]);
    return rows[0]!.hidden_at;
  });
}

async function actionsFor(postId: string): Promise<string[]> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ action: string }>(
      `SELECT action FROM moderation_actions WHERE post_id = $1 ORDER BY created_at`,
      [postId],
    );
    return rows.map((r) => r.action);
  });
}

function randomSha(): string {
  return crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
}
function keyFor(sha: string): string {
  return `media/post/${sha}.webp`;
}
function markdownWith(sha: string): string {
  return `![img](https://cdn.thinkersjournal.com/${keyFor(sha)})`;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /posts/:id/hide", () => {
  it("hides the author's own post and logs an author_hide action", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);

    const res = await hide(author, postId);
    expect(res.status).toBe(200);
    expect(await hiddenAtOf(postId)).not.toBeNull();
    expect(await actionsFor(postId)).toEqual(["author_hide"]);
  });

  it("is idempotent — hiding an already-hidden post logs nothing new", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);
    await hide(author, postId);
    const firstHiddenAt = await hiddenAtOf(postId);

    const res = await hide(author, postId);
    expect(res.status).toBe(200);
    expect(await hiddenAtOf(postId)).toEqual(firstHiddenAt); // never restamped
    expect(await actionsFor(postId)).toEqual(["author_hide"]); // no second row
  });

  it("404s a non-owner", async () => {
    const author = await createVerifiedActor();
    const stranger = await createVerifiedActor();
    const postId = await seedPost(author);

    const res = await hide(stranger, postId);
    expect(res.status).toBe(404);
    expect(await hiddenAtOf(postId)).toBeNull();
  });

  it("moves unshared media to the restricted bucket, and the author can still fetch it", async () => {
    const author = await createVerifiedActor();
    const sha = randomSha();
    const postId = await seedPost(author, markdownWith(sha));
    await env.MEDIA.put(keyFor(sha), "bytes");

    const res = await hide(author, postId);
    expect(res.status).toBe(200);
    expect(await env.MEDIA.head(keyFor(sha))).toBeNull();
    expect(await env.MEDIA_RESTRICTED.head(keyFor(sha))).not.toBeNull();

    const mediaRes = await fetchWorker(
      new Request(`https://api.test/media/restricted/${sha}?subject=post&subjectId=${postId}`, {
        headers: { Cookie: author.cookie },
      }),
    );
    expect(mediaRes.status).toBe(200);
  });
});

describe("POST /posts/:id/unhide", () => {
  it("unhides a post the author hid themselves, and moves media back", async () => {
    const author = await createVerifiedActor();
    const sha = randomSha();
    const postId = await seedPost(author, markdownWith(sha));
    await env.MEDIA.put(keyFor(sha), "bytes");
    await hide(author, postId);

    const res = await unhide(author, postId);
    expect(res.status).toBe(200);
    expect(await hiddenAtOf(postId)).toBeNull();
    expect(await actionsFor(postId)).toEqual(["author_hide", "author_unhide"]);
    expect(await env.MEDIA.head(keyFor(sha))).not.toBeNull();
  });

  it("is idempotent — unhiding an already-visible post is a no-op", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);
    const res = await unhide(author, postId);
    expect(res.status).toBe(200);
    expect(await actionsFor(postId)).toEqual([]);
  });

  it("404s a non-owner", async () => {
    const author = await createVerifiedActor();
    const stranger = await createVerifiedActor();
    const postId = await seedPost(author);
    await hide(author, postId);

    const res = await unhide(stranger, postId);
    expect(res.status).toBe(404);
    expect(await hiddenAtOf(postId)).not.toBeNull();
  });

  it("403s HIDE_NOT_REVERSIBLE for an auto-hidden post with no decision yet", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);
    await autoHide(postId);

    const res = await unhide(author, postId);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "HIDE_NOT_REVERSIBLE" });
    expect(await hiddenAtOf(postId)).not.toBeNull();
  });

  it("403s HIDE_NOT_REVERSIBLE for a moderator's keep_hidden decision", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);
    await moderatorKeepHidden(postId);

    const res = await unhide(author, postId);
    expect(res.status).toBe(403);
    expect(await hiddenAtOf(postId)).not.toBeNull();
  });
});
