import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DELETE_REQUEST_RESEND_TTL_HOURS } from "@thinkersjournal/shared";

import worker from "../src";
import { withClient } from "../src/db/client";
import { mintActionToken } from "../src/moderation/action-tokens";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Client } from "pg";

/**
 * `GET /account/delete-request/token`, `POST /account/delete-request`, and
 * `POST /account/delete-request/resend` (#113 plan B, Task 5) — a barred
 * user's way to ask for their account to be deleted, by emailed token, with
 * no session.
 */

const ALLOWED_ORIGIN = "http://localhost:8787";
const HOUR = 3600_000;
const DAY_MS = 24 * HOUR;

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  opts: { createdAt?: Date } = {},
): Promise<string> {
  const rows = await sql<{ id: string }>(
    `INSERT INTO moderation_actions (actor_admin, action, subject_user_id, reason, created_at)
     VALUES ('mod', $1, $2, 'r', COALESCE($3, now())) RETURNING id`,
    [action, userId, opts.createdAt ?? null],
  );
  return rows[0]!.id;
}

async function mintDeleteRequestToken(userId: string, actionId: string, ttlMs = DAY_MS): Promise<string> {
  const token = await ctxRun((c) => mintActionToken(c, { actionId, userId, purpose: "delete_request", ttlMs }));
  expect(token).not.toBeNull();
  return token!;
}

async function mintAppealToken(userId: string, actionId: string): Promise<string> {
  const token = await ctxRun((c) => mintActionToken(c, { actionId, userId, purpose: "appeal", ttlMs: DAY_MS }));
  expect(token).not.toBeNull();
  return token!;
}

async function suspend(userId: string, untilMs: number): Promise<void> {
  await sql(`UPDATE users SET suspended_until = now() + make_interval(secs => $2::double precision / 1000) WHERE id = $1`, [
    userId,
    untilMs,
  ]);
}

async function ban(userId: string): Promise<void> {
  await sql(`UPDATE users SET disabled_at = now(), disabled_reason = 'ban' WHERE id = $1`, [userId]);
}

async function deletionRequestedAt(userId: string): Promise<Date | null> {
  const rows = await sql<{ deletion_requested_at: Date | null }>(
    `SELECT deletion_requested_at FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]!.deletion_requested_at;
}

async function tokenUsedAt(actionId: string): Promise<Date | null> {
  const rows = await sql<{ used_at: Date | null }>(
    `SELECT used_at FROM moderation_action_tokens WHERE action_id = $1`,
    [actionId],
  );
  return rows[0]!.used_at;
}

describe("GET /account/delete-request/token", () => {
  it("a barred account's token peeks 200 { ok: true } any number of times, leaving it redeemable", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_ban");
    await ban(actor.userId);
    const token = await mintDeleteRequestToken(actor.userId, actionId);

    for (let i = 0; i < 3; i++) {
      const res = await fetchWorker(tokenGet(`/account/delete-request/token?token=${token}`));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(await tokenUsedAt(actionId)).toBeNull();
  });
});

describe("POST /account/delete-request", () => {
  it("records the request, spends the token; a second POST is 400 INVALID_TOKEN", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_ban");
    await ban(actor.userId);
    const token = await mintDeleteRequestToken(actor.userId, actionId);

    const res = await fetchWorker(tokenPost("/account/delete-request", { token, confirm: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
    expect(await deletionRequestedAt(actor.userId)).not.toBeNull();

    const again = await fetchWorker(tokenPost("/account/delete-request", { token, confirm: true }));
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("⚠️ T3/T5: a lapsed suspension's link is 400 INVALID_TOKEN for both GET peek and POST, byte-identical to an expired token; the token stays unspent and nothing is recorded (CONTROL: a still-suspended account's token works)", async () => {
    const lapsed = await createVerifiedActor();
    const lapsedActionId = await seedAction(lapsed.userId, "user_suspend");
    const lapsedToken = await mintDeleteRequestToken(lapsed.userId, lapsedActionId);
    await suspend(lapsed.userId, 60_000); // still suspended at mint time
    await sql(`UPDATE users SET suspended_until = now() - interval '1 minute' WHERE id = $1`, [lapsed.userId]);

    const stillSuspended = await createVerifiedActor();
    const stillActionId = await seedAction(stillSuspended.userId, "user_suspend");
    const stillToken = await mintDeleteRequestToken(stillSuspended.userId, stillActionId);
    await suspend(stillSuspended.userId, HOUR);

    // Control: still-suspended account's token works — both the peek AND a
    // POST (the positive control that proves the 400s below are about the
    // LAPSE, not some other reason a delete-request could fail).
    const controlPeek = await fetchWorker(tokenGet(`/account/delete-request/token?token=${stillToken}`));
    expect(controlPeek.status, "CONTROL: still-suspended token peeks 200").toBe(200);
    const controlPost = await fetchWorker(tokenPost("/account/delete-request", { token: stillToken, confirm: true }));
    expect(controlPost.status, "CONTROL: still-suspended token POSTs 200").toBe(200);

    // Expired-token comparator, minted with ttlMs: -1.
    const expiredActionId = await seedAction(stillSuspended.userId, "user_suspend");
    const expiredToken = await mintDeleteRequestToken(stillSuspended.userId, expiredActionId, -1);

    const lapsedPeek = await fetchWorker(tokenGet(`/account/delete-request/token?token=${lapsedToken}`));
    const expiredPeek = await fetchWorker(tokenGet(`/account/delete-request/token?token=${expiredToken}`));
    expect(lapsedPeek.status).toBe(400);
    expect(lapsedPeek.status).toBe(expiredPeek.status);
    const lapsedPeekText = await lapsedPeek.text();
    const expiredPeekText = await expiredPeek.text();
    expect(lapsedPeekText, "byte-identical bodies, not merely equal JSON").toBe(expiredPeekText);
    expect(JSON.parse(lapsedPeekText)).toEqual(JSON.parse(expiredPeekText));

    const lapsedPost = await fetchWorker(tokenPost("/account/delete-request", { token: lapsedToken, confirm: true }));
    const expiredPost = await fetchWorker(tokenPost("/account/delete-request", { token: expiredToken, confirm: true }));
    expect(lapsedPost.status).toBe(400);
    expect(lapsedPost.status).toBe(expiredPost.status);
    const lapsedPostText = await lapsedPost.text();
    const expiredPostText = await expiredPost.text();
    expect(lapsedPostText, "byte-identical bodies, not merely equal JSON").toBe(expiredPostText);
    expect(JSON.parse(lapsedPostText)).toEqual(JSON.parse(expiredPostText));

    expect(await deletionRequestedAt(lapsed.userId)).toBeNull();
    expect(await tokenUsedAt(lapsedActionId)).toBeNull();
  });

  it("⚠️ B3: a barred account's token, then anonymised → 400 INVALID_TOKEN, deletion_requested_at unchanged, token unspent", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_ban");
    await ban(actor.userId);
    const token = await mintDeleteRequestToken(actor.userId, actionId);

    await sql(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [actor.userId]);

    const res = await fetchWorker(tokenPost("/account/delete-request", { token, confirm: true }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_TOKEN" });
    expect(await deletionRequestedAt(actor.userId)).toBeNull();
    expect(await tokenUsedAt(actionId)).toBeNull();
  });

  it("without confirm: true is 400 INVALID_INPUT, and the token is not spent", async () => {
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_ban");
    await ban(actor.userId);
    const token = await mintDeleteRequestToken(actor.userId, actionId);

    const res = await fetchWorker(tokenPost("/account/delete-request", { token }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(await tokenUsedAt(actionId)).toBeNull();
  });

  it("⚠️ Review Focus 1 (the other direction): an appeal token here is 400 INVALID_TOKEN, and still works at POST /appeals/by-token", async () => {
    // Barred, so the 400 below can only come from the purpose mismatch, not
    // from `barredNow` — isolating the mutation this test is meant to pin.
    const actor = await createVerifiedActor();
    const actionId = await seedAction(actor.userId, "user_ban");
    await ban(actor.userId);
    const token = await mintAppealToken(actor.userId, actionId);

    const res = await fetchWorker(tokenPost("/account/delete-request", { token, confirm: true }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_TOKEN" });

    const appeal = await fetchWorker(tokenPost("/appeals/by-token", { token, body: "still works" }));
    expect(appeal.status).toBe(201);
  });

  it("a request on an already-requested account keeps the EARLIER deletion_requested_at (COALESCE)", async () => {
    const actor = await createVerifiedActor();
    const earlier = new Date(Date.now() - 10 * DAY_MS);
    await sql(`UPDATE users SET deletion_requested_at = $2 WHERE id = $1`, [actor.userId, earlier]);
    const actionId = await seedAction(actor.userId, "user_ban");
    await ban(actor.userId);
    const token = await mintDeleteRequestToken(actor.userId, actionId);

    const res = await fetchWorker(tokenPost("/account/delete-request", { token, confirm: true }));
    expect(res.status).toBe(200);

    const after = await deletionRequestedAt(actor.userId);
    expect(after?.getTime()).toBe(earlier.getTime());
  });
});

/** Same stub shape as test/forgot-password.test.ts's. */
function stubFetch(turnstileSuccess: boolean): RequestInit[] {
  const postmarkCalls: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://challenges.cloudflare.com/")) {
        return new Response(JSON.stringify({ success: turnstileSuccess }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://api.postmarkapp.com/")) {
        postmarkCalls.push(init ?? {});
        return new Response(JSON.stringify({ ErrorCode: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
  return postmarkCalls;
}

function postmarkBody(calls: RequestInit[], index = 0): Record<string, unknown> {
  return JSON.parse(String(calls[index]!.body)) as Record<string, unknown>;
}

function resendRequest(email: string): Request {
  return tokenPost("/account/delete-request/resend", { email, turnstileToken: "dummy-turnstile-token" });
}

async function lookupEmail(userId: string): Promise<string> {
  const rows = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  return rows[0]!.email;
}

function uniqueEmail(): string {
  return `delreq_${crypto.randomUUID().replace(/-/g, "")}@example.com`;
}

describe("POST /account/delete-request/resend", () => {
  it("a barred account: 202, one email to the account's address containing /account/delete-request?token=, a new delete_request token expiring in about 24h, redeemable end to end", async () => {
    const actor = await createVerifiedActor();
    await seedAction(actor.userId, "user_ban");
    await ban(actor.userId);
    const email = await lookupEmail(actor.userId);

    const calls = stubFetch(true);
    const res = await fetchWorker(resendRequest(email));
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    const body = postmarkBody(calls);
    expect(body.To, "mailed to the account's stored address").toBe(email);
    const match = /\/account\/delete-request\?token=([^"\\<\s]+)/.exec(String(body.TextBody));
    expect(match, "no delete-request link found in the mailed body").not.toBeNull();
    const mailedToken = decodeURIComponent(match![1]!);

    const rows = await sql<{ expires_at: Date }>(
      `SELECT expires_at FROM moderation_action_tokens WHERE user_id = $1 AND purpose = 'delete_request' ORDER BY created_at DESC LIMIT 1`,
      [actor.userId],
    );
    const ttlHours = (rows[0]!.expires_at.getTime() - Date.now()) / HOUR;
    // A small slack (6 min) absorbs clock skew between this process and the
    // DB server's `now()` — the point is "about 24h", not an exact bound.
    const SLACK_HOURS = 0.1;
    expect(ttlHours).toBeGreaterThan(DELETE_REQUEST_RESEND_TTL_HOURS - 1);
    expect(ttlHours).toBeLessThanOrEqual(DELETE_REQUEST_RESEND_TTL_HOURS + SLACK_HOURS);

    // End to end: the mailed token actually redeems.
    const confirm = await fetchWorker(tokenPost("/account/delete-request", { token: mailedToken, confirm: true }));
    expect(confirm.status).toBe(200);
    expect(await confirm.json()).toEqual({ recorded: true });
  });

  it("an unbarred account, an unknown address, and an anonymised account all get the SAME 202 empty body with no email (byte-identical to the barred case)", async () => {
    const barred = await createVerifiedActor();
    await seedAction(barred.userId, "user_ban");
    await ban(barred.userId);
    const barredEmail = await lookupEmail(barred.userId);

    const unbarred = await createVerifiedActor();
    const unbarredEmail = await lookupEmail(unbarred.userId);

    const anonymised = await createVerifiedActor();
    await seedAction(anonymised.userId, "user_ban");
    await ban(anonymised.userId);
    const anonEmail = await lookupEmail(anonymised.userId);
    await sql(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [anonymised.userId]);

    const barredCalls = stubFetch(true);
    const barredRes = await fetchWorker(resendRequest(barredEmail));
    expect(barredRes.status).toBe(202);
    expect(await barredRes.text()).toBe("");
    expect(barredCalls).toHaveLength(1);
    vi.unstubAllGlobals();

    const unbarredCalls = stubFetch(true);
    const unbarredRes = await fetchWorker(resendRequest(unbarredEmail));
    vi.unstubAllGlobals();

    const unknownCalls = stubFetch(true);
    const unknownRes = await fetchWorker(resendRequest(uniqueEmail()));
    vi.unstubAllGlobals();

    const anonCalls = stubFetch(true);
    const anonRes = await fetchWorker(resendRequest(anonEmail));

    for (const [res, calls] of [
      [unbarredRes, unbarredCalls],
      [unknownRes, unknownCalls],
      [anonRes, anonCalls],
    ] as const) {
      expect(res.status).toBe(barredRes.status);
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("");
      expect(calls).toHaveLength(0);
    }

    // No delete_request token was minted for either account that didn't
    // qualify — not merely "no mail", but nothing written at all.
    expect(
      await sql(`SELECT 1 FROM moderation_action_tokens WHERE user_id = $1 AND purpose = 'delete_request'`, [
        unbarred.userId,
      ]),
    ).toEqual([]);
    expect(
      await sql(`SELECT 1 FROM moderation_action_tokens WHERE user_id = $1 AND purpose = 'delete_request'`, [
        anonymised.userId,
      ]),
    ).toEqual([]);
  });
});
