import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor } from "./actor";

import type { Actor } from "./actor";

/**
 * REGRESSION for a shipped bug in `LATEST_VISIBILITY_ACTION_IS_AUTHOR_HIDE_SQL`
 * (src/moderation/author-hide.ts), found in review of #78's design.
 *
 * `moderation_actions` is ONE shared append-only log carrying non-visibility
 * actions too — `media_access` (0016) is the confirmed LIVE case: an admin
 * viewing a hidden post's restricted media (`routes/media-restricted.ts`'s
 * ordinary tier) appends a `media_access` row carrying that post's `post_id`.
 * The predicate that decides "is this post's current hide the author's own"
 * previously took the log's LATEST row with no filter on action type — so an
 * admin merely VIEWING a hidden post's media after the author hid it would
 * silently and permanently block that author from ever unhiding it, with no
 * moderator decision ever having been made. Fixed by filtering to
 * visibility-affecting actions before taking the latest one, matching
 * `moderation/queue.ts`'s own `content\_%` filter precedent on the same log.
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
  const response = await worker.fetch(
    request,
    { ...env, WEB: { fetch: async () => new Response("{}", { status: 200 }) } } as never,
    ctx,
  );
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

async function seedPost(actor: Actor): Promise<string> {
  return ctxRun(async (c) => {
    const slug = "test-" + crypto.randomUUID().slice(0, 8);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 'test', $2, 'test', 'published', now()) RETURNING id`,
      [actor.userId, slug],
    );
    return rows[0]!.id;
  });
}

/** Simulates exactly what routes/media-restricted.ts's admin (non-author) path writes. */
async function adminViewedRestrictedMedia(postId: string): Promise<void> {
  await ctxRun((c) =>
    c.query(
      `INSERT INTO moderation_actions (actor_admin, action, post_id, reason)
       VALUES ('admin@example.test', 'media_access', $1, 'Admin viewed hidden content''s media')`,
      [postId],
    ),
  );
}

async function moderatorKeepHidden(postId: string): Promise<void> {
  await ctxRun((c) =>
    c.query(
      `INSERT INTO moderation_actions (actor_admin, action, post_id, reason)
       VALUES ('mod@example.test', 'content_keep_hidden', $1, 'r')`,
      [postId],
    ),
  );
}

describe("author-hide vs. an interleaved media_access row", () => {
  it("an admin viewing the restricted media AFTER an author_hide does not block the author's own unhide", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);

    const hideRes = await hide(author, postId);
    expect(hideRes.status).toBe(200);

    // The confirmed live interleaving: an admin views the hidden post's media,
    // appending a media_access row with a LATER created_at than author_hide.
    await adminViewedRestrictedMedia(postId);

    const unhideRes = await unhide(author, postId);
    expect(unhideRes.status).toBe(200);
  });

  it("does NOT mask a genuine moderator decision that came after the media_access row", async () => {
    const author = await createVerifiedActor();
    const postId = await seedPost(author);

    const hideRes = await hide(author, postId);
    expect(hideRes.status).toBe(200);
    await adminViewedRestrictedMedia(postId);
    // A REAL moderator decision, still the latest VISIBILITY action even
    // though media_access is technically the latest row of any kind.
    await moderatorKeepHidden(postId);

    const unhideRes = await unhide(author, postId);
    expect(unhideRes.status).toBe(403);
    const body = (await unhideRes.json()) as { code?: string };
    expect(body.code).toBe("POST_UNDER_MODERATION");
  });
});
