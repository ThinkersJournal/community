import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { mintActionToken } from "../src/moderation/action-tokens";
import { fileAppeal } from "../src/moderation/appeals";
import { createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";
import type { Client } from "pg";

/**
 * Filing an appeal (#113 plan B, Task 4) — by emailed token (no session) or
 * signed in, plus the editor-banner lookup `GET /appeals/for-post/:postId`.
 */

const ALLOWED_ORIGIN = "http://localhost:8787";
const HOUR = 3600_000;
const DAY_MS = 24 * 3600_000;

afterEach(async () => {
  await deleteCreatedUsers();
});

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function ctxRun<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return ctxRun(async (c) => (await c.query<T>(text, params)).rows);
}

function mutating(actor: Actor, method: string, path: string, body?: unknown): Request {
  return new Request(`https://api.test${path}`, {
    method,
    headers: {
      Origin: ALLOWED_ORIGIN,
      Cookie: actor.cookie,
      "X-CSRF-Token": actor.csrfToken,
      "content-type": "application/json",
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

function tokenPost(path: string, body: unknown): Request {
  return new Request(`https://api.test${path}`, {
    method: "POST",
    headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tokenGet(path: string): Request {
  return new Request(`https://api.test${path}`);
}

async function seedAction(
  userId: string,
  action: string,
  opts: { postId?: string; createdAt?: Date } = {},
): Promise<string> {
  const rows = await sql<{ id: string }>(
    `INSERT INTO moderation_actions (actor_admin, action, subject_user_id, post_id, reason, created_at)
     VALUES ('mod', $1, $2, $3, 'r', COALESCE($4, now())) RETURNING id`,
    [action, userId, opts.postId ?? null, opts.createdAt ?? null],
  );
  return rows[0]!.id;
}

async function mintAppealToken(userId: string, actionId: string, ttlMs = DAY_MS): Promise<string> {
  const token = await ctxRun((c) => mintActionToken(c, { actionId, userId, purpose: "appeal", ttlMs }));
  expect(token).not.toBeNull();
  return token!;
}

async function mintDeleteRequestToken(userId: string, actionId: string): Promise<string> {
  const token = await ctxRun((c) => mintActionToken(c, { actionId, userId, purpose: "delete_request", ttlMs: HOUR }));
  expect(token).not.toBeNull();
  return token!;
}

async function appealsCount(actionId: string): Promise<number> {
  const rows = await sql<{ count: string }>(`SELECT count(*)::text AS count FROM appeals WHERE action_id = $1`, [actionId]);
  return Number(rows[0]!.count);
}

describe("POST /appeals/by-token", () => {
  it("files an appeal and consumes the token; reusing the token is 400 INVALID_TOKEN", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_warn");
    const token = await mintAppealToken(actor.userId, actionId);

    const res = await fetchWorker(tokenPost("/appeals/by-token", { token, body: "I disagree." }));
    expect(res.status).toBe(201);
    expect(await appealsCount(actionId)).toBe(1);

    const again = await fetchWorker(tokenPost("/appeals/by-token", { token, body: "retry" }));
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("⚠️ Review Focus 2: any number of GET /appeals/token peeks leave the token redeemable", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_warn");
    const token = await mintAppealToken(actor.userId, actionId);

    for (let i = 0; i < 3; i++) {
      const peek = await fetchWorker(tokenGet(`/appeals/token?token=${token}`));
      expect(peek.status).toBe(200);
    }
    const res = await fetchWorker(tokenPost("/appeals/by-token", { token, body: "still good" }));
    expect(res.status).toBe(201);
  });

  it("⚠️ Review Focus 1: a delete_request token is 400 INVALID_TOKEN here, and stays unconsumed (its own route is a later task)", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_ban");
    const token = await mintDeleteRequestToken(actor.userId, actionId);

    const res = await fetchWorker(tokenPost("/appeals/by-token", { token, body: "wrong purpose" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_TOKEN" });
    expect(await appealsCount(actionId)).toBe(0);

    // This task has no delete-request ROUTE to prove the token still works
    // for its own purpose through HTTP — only that this route didn't consume
    // it. Peeking it as an "appeal" token also answers 400 (wrong purpose for
    // THIS route too); the assertion that matters is `used_at IS NULL` below.
    const peek = await fetchWorker(tokenGet(`/appeals/token?token=${token}`));
    expect(peek.status).toBe(400); // wrong purpose for THIS route too — the point is it's not consumed.
    const { rows } = await ctxRun((c) =>
      c.query<{ used_at: Date | null }>(`SELECT used_at FROM moderation_action_tokens WHERE action_id = $1`, [actionId]),
    );
    expect(rows).toEqual([{ used_at: null }]);
  });

  it("⚠️ Review Focus 3: a second appeal against the same action is 409, and does NOT burn the second token", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_warn");
    const tokenA = await mintAppealToken(actor.userId, actionId);
    const tokenB = await mintAppealToken(actor.userId, actionId);

    const first = await fetchWorker(tokenPost("/appeals/by-token", { token: tokenA, body: "first" }));
    expect(first.status).toBe(201);

    const second = await fetchWorker(tokenPost("/appeals/by-token", { token: tokenB, body: "second" }));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "APPEAL_EXISTS" });

    const peek = await fetchWorker(tokenGet(`/appeals/token?token=${tokenB}`));
    expect(peek.status).toBe(200);
  });

  it("a blank body is 400 INVALID_INPUT and does not burn the token", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_warn");
    const token = await mintAppealToken(actor.userId, actionId);

    const res = await fetchWorker(tokenPost("/appeals/by-token", { token, body: "   " }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });

    const peek = await fetchWorker(tokenGet(`/appeals/token?token=${token}`));
    expect(peek.status).toBe(200);
  });

  it("an action older than 30 days is 409 APPEAL_WINDOW_CLOSED (token minted with a long TTL to isolate the window)", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_warn", { createdAt: new Date(Date.now() - 31 * DAY_MS) });
    const token = await mintAppealToken(actor.userId, actionId, 365 * DAY_MS);

    const res = await fetchWorker(tokenPost("/appeals/by-token", { token, body: "too late" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "APPEAL_WINDOW_CLOSED" });
  });

  it("a user_terminate action is never appealable: 409 NOT_APPEALABLE", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_terminate");
    const token = await mintAppealToken(actor.userId, actionId);

    const res = await fetchWorker(tokenPost("/appeals/by-token", { token, body: "csam appeal attempt" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "NOT_APPEALABLE" });
  });

  it("⚠️ B3: an anonymised appellant's token → 400 INVALID_TOKEN, no appeals row, token unspent", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_warn");
    const token = await mintAppealToken(actor.userId, actionId);

    await sql(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [actor.userId]);

    const peek = await fetchWorker(tokenGet(`/appeals/token?token=${token}`));
    expect(peek.status).toBe(400);

    const res = await fetchWorker(tokenPost("/appeals/by-token", { token, body: "deleted account" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_TOKEN" });

    expect(await appealsCount(actionId)).toBe(0);
    const { rows } = await ctxRun((c) =>
      c.query<{ used_at: Date | null }>(`SELECT used_at FROM moderation_action_tokens WHERE action_id = $1`, [actionId]),
    );
    expect(rows).toEqual([{ used_at: null }]);
  });
});

describe("fileAppeal (direct, no HTTP layer)", () => {
  // Controller fix round 1, I2: `fileAppeal`'s own `AND u.anonymised_at IS
  // NULL` (moderation/appeals.ts) has no test that can fail it on its own —
  // every HTTP-level B3 case goes through `consumeActionToken`'s guard
  // FIRST, so a regression in `fileAppeal`'s predicate would never be
  // observed there. This calls `fileAppeal` directly, bypassing the token
  // layer entirely, to pin fileAppeal's OWN guard.
  it("⚠️ B3: fileAppeal refuses an anonymised appellant even when called directly", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_warn");
    await sql(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [actor.userId]);

    const outcome = await ctxRun((c) => fileAppeal(c, { actionId, appellantId: actor.userId, body: "x" }));
    expect(outcome).toEqual({ kind: "not_found" });
    expect(await appealsCount(actionId)).toBe(0);
  });
});

describe("POST /appeals (signed in)", () => {
  it("the content's author can appeal its keep_hidden/remove action", async () => {
    const actor = await createVerifiedActor();
    const postId = await createPublished(actor);
    const actionId = await seedAction(actor.userId, "content_keep_hidden", { postId });

    const res = await fetchWorker(mutating(actor, "POST", "/appeals", { actionId, body: "Please reconsider." }));
    expect(res.status).toBe(201);
  });

  it("another member cannot appeal someone else's action: 404", async () => {
    const owner = await createVerifiedActor();
    const other = await createVerifiedActor();
    const postId = await createPublished(owner);
    const actionId = await seedAction(owner.userId, "content_keep_hidden", { postId });

    const res = await fetchWorker(mutating(other, "POST", "/appeals", { actionId, body: "not mine" }));
    expect(res.status).toBe(404);
  });

  it("a barred session is refused by the pipeline (403 ACCOUNT_BARRED) — the token path is theirs", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_ban");
    // A BAN is `disabled_at`, permanent — not `suspended_until`, which is a
    // temporary bar and the wrong column for this action (account-status.ts).
    await sql(`UPDATE users SET disabled_at = now(), disabled_reason = 'ban' WHERE id = $1`, [actor.userId]);

    const res = await fetchWorker(mutating(actor, "POST", "/appeals", { actionId, body: "let me back in" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "ACCOUNT_BARRED" });
  });
});

describe("GET /appeals/for-post/:postId", () => {
  it("returns the LATEST of two decisions (keep_hidden, then remove) — not merely A decision", async () => {
    const actor = await createVerifiedActor();
    const postId = await createPublished(actor);
    await sql(`UPDATE posts SET hidden_at = now() WHERE id = $1`, [postId]);
    // keep_hidden an hour ago, remove just now — the query must prefer the
    // chronologically later row, not whichever one a plain scan meets first.
    await seedAction(actor.userId, "content_keep_hidden", { postId, createdAt: new Date(Date.now() - HOUR) });
    const removeId = await seedAction(actor.userId, "content_remove", { postId });

    const res = await fetchWorker(mutating(actor, "GET", `/appeals/for-post/${postId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target: { actionId: string } | null };
    expect(body.target?.actionId).toBe(removeId);
  });

  it("a post hidden only by auto-hide (no decision yet) → 200 { target: null } — nothing to appeal yet", async () => {
    const actor = await createVerifiedActor();
    const postId = await createPublished(actor);
    await sql(`UPDATE posts SET hidden_at = now() WHERE id = $1`, [postId]);

    const res = await fetchWorker(mutating(actor, "GET", `/appeals/for-post/${postId}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ target: null });
  });

  it("a keep_hidden later REVERSED by a restore (post visible) → { target: null }", async () => {
    const actor = await createVerifiedActor();
    const postId = await createPublished(actor);
    await seedAction(actor.userId, "content_keep_hidden", { postId });
    await sql(`UPDATE posts SET hidden_at = NULL WHERE id = $1`, [postId]);
    await seedAction(actor.userId, "content_restore", { postId });

    const res = await fetchWorker(mutating(actor, "GET", `/appeals/for-post/${postId}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ target: null });
  });

  // Controller fix round 1, I1 — the brief's missing case: a restore's
  // GOVERNING effect must survive a LATER, independent re-hide with no new
  // decision (e.g. auto-hide firing again). The latest DECISION is still the
  // restore, so there is nothing to appeal, even though the post reads
  // hidden right now.
  it("a keep_hidden → restore → later re-hidden with NO new decision → { target: null }", async () => {
    const actor = await createVerifiedActor();
    const postId = await createPublished(actor);
    await seedAction(actor.userId, "content_keep_hidden", { postId });
    await sql(`UPDATE posts SET hidden_at = NULL WHERE id = $1`, [postId]);
    await seedAction(actor.userId, "content_restore", { postId });
    // Re-hidden (e.g. auto-hide again) with no accompanying moderation_actions row.
    await sql(`UPDATE posts SET hidden_at = now() WHERE id = $1`, [postId]);

    const res = await fetchWorker(mutating(actor, "GET", `/appeals/for-post/${postId}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ target: null });
  });

  it("someone else's post → 404", async () => {
    const owner = await createVerifiedActor();
    const other = await createVerifiedActor();
    const postId = await createPublished(owner);

    const res = await fetchWorker(mutating(other, "GET", `/appeals/for-post/${postId}`));
    expect(res.status).toBe(404);
  });

  // Minor (2) — the JOIN's `u.anonymised_at IS NULL` guard: a surviving
  // session (epoch not yet bumped) for an account the scrub has already
  // anonymised must read NOTHING, same as every other B3 defense-in-depth
  // layer in this plan.
  it("⚠️ B3/minor(2): an anonymised account's surviving session reads nothing here: 404", async () => {
    const actor = await createVerifiedActor();
    const postId = await createPublished(actor);
    await sql(`UPDATE posts SET hidden_at = now() WHERE id = $1`, [postId]);
    await seedAction(actor.userId, "content_keep_hidden", { postId });

    await sql(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [actor.userId]);

    const res = await fetchWorker(mutating(actor, "GET", `/appeals/for-post/${postId}`));
    expect(res.status).toBe(404);
  });
});
