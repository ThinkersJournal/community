import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import {
  createVerificationToken,
  TEST_LAST_TOKEN_KEY,
} from "../src/auth/email-verify";
import { createUnverifiedActor, createVerifiedActor, deleteCreatedUsers } from "./actor";
import { awaitLimiterBurstWindow } from "./helpers/limiter-window";

import type { Actor } from "./actor";

/**
 * Task 10 — `POST /auth/resend-verification` (M0 carry-over, load-bearing for
 * M1: posting now REQUIRES a verified email, and this is the only recovery
 * from a dropped verification mail short of re-signup).
 *
 * Runs in the POOL project (real workerd): needs `SESSIONS` KV,
 * `HYPERDRIVE_FRESH`, `USER_SECURITY` (DO) and `RESEND_LIMITER`.
 *
 * ⚠️ Global `fetch` is stubbed (Postmark) in every case that reaches the send —
 * see `stubPostmark`. Restored in `afterEach` so the stub cannot leak into
 * sibling pool test files sharing this workerd isolate.
 */

/** An allowlisted origin (src/auth/csrf.ts) — the route 403s without one. */
const ALLOWED_ORIGIN = "http://localhost:8787";

/**
 * The origin an emailed verification link must be built on when the request
 * carries no PRODUCTION origin. See `verificationLinkOrigin`
 * (src/auth/email-verify.ts) — shared with signup, and NOT derived from the
 * request URL.
 */
const CANONICAL_ORIGIN = "https://community.thinkersjournal.com";

/** Drive the Worker through a full request lifecycle. */
async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * `POST /auth/resend-verification` for `actor`: full Origin + session + CSRF.
 * `origin` overrides the request's `Origin` — it must stay in `checkOrigin`'s
 * allowlist or the route 403s before doing anything.
 */
async function resend(actor: Actor, origin: string = ALLOWED_ORIGIN): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/auth/resend-verification", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
      },
    }),
  );
}

/**
 * The most recently issued RAW verification token, from the TEST-ONLY stash
 * (`TEST_ROUTES === "1"`; src/auth/email-verify.ts). Holds only the MOST
 * RECENT token, so read it immediately after the send whose token you want.
 */
async function lastVerifyToken(): Promise<string> {
  const token = await env.SESSIONS.get(TEST_LAST_TOKEN_KEY);
  expect(token).not.toBeNull();
  return token!;
}

/**
 * An unverified actor that already holds a PENDING verification token, as if
 * signup had just run.
 *
 * ⚠️ `createUnverifiedActor` (test/actor.ts) deliberately bypasses the signup
 * ROUTE (its own header explains why: no live Postmark call, no coupling to
 * four unrelated routes) and therefore never mints a token. This suite's whole
 * point is a SECOND token coexisting with a FIRST one, so it needs a real first
 * token to coexist with — minted directly via `createVerificationToken`, the
 * same primitive signup itself calls.
 */
async function unverifiedActorWithPendingToken(): Promise<{
  actor: Actor;
  token: string;
}> {
  const actor = await createUnverifiedActor();
  const token = await createVerificationToken(env, actor.userId);
  return { actor, token };
}

/**
 * Stub the global `fetch` so `sendVerificationEmail`'s Postmark call never
 * leaves the process — every case that reaches a successful resend triggers a
 * real send otherwise. Mirrors test/signup.test.ts and test/email-verify.test.ts.
 *
 * Returns the captured Postmark request inits, so a case can assert what was
 * actually mailed rather than merely that a send happened.
 */
function stubPostmark(): RequestInit[] {
  const postmarkCalls: RequestInit[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.postmarkapp.com/")) {
        // Fail loudly rather than silently returning a bogus body: this route
        // must make no outbound call other than the Postmark send.
        throw new Error(`unexpected fetch to ${url}`);
      }
      postmarkCalls.push(init ?? {});
      return new Response(JSON.stringify({ ErrorCode: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  return postmarkCalls;
}

/** The parsed Postmark JSON body of the Nth captured send. */
function postmarkBody(calls: RequestInit[], index = 0): Record<string, unknown> {
  return JSON.parse(String(calls[index]!.body)) as Record<string, unknown>;
}

beforeEach(async () => {
  // Sessions AND verification tokens both live in SESSIONS; clear it so each
  // case observes only its own writes.
  let cursor: string | undefined;
  do {
    const result = await env.SESSIONS.list(cursor ? { cursor } : undefined);
    await Promise.all(result.keys.map((k) => env.SESSIONS.delete(k.name)));
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor !== undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await deleteCreatedUsers();
});

describe("POST /auth/resend-verification", () => {
  it("202s for an unverified session and mints a NEW usable token", async () => {
    stubPostmark();
    const { actor, token: first } = await unverifiedActorWithPendingToken();

    const response = await resend(actor);
    expect(response.status).toBe(202);

    const second = await lastVerifyToken();
    expect(second).not.toBe(first);

    // The new token must actually verify — a resend that mints a dead token is
    // worse than no resend at all.
    const verify = await fetchWorker(
      new Request(
        `https://api.test/verify-email?token=${encodeURIComponent(second)}`,
        { headers: { Cookie: actor.cookie } },
      ),
    );
    expect(verify.status).toBe(200);
  });

  it("does NOT invalidate the previous token", async () => {
    stubPostmark();
    // The user may still click the FIRST email — that is the likeliest case
    // when "resend" was pressed because the first was slow, not lost.
    const { actor, token: first } = await unverifiedActorWithPendingToken();

    // Asserted here too (not just in the previous case): without it this test
    // would pass vacuously against a 404 — the FIRST token verifies whether or
    // not the resend route exists at all, since it was minted independently.
    expect((await resend(actor)).status).toBe(202);

    const verify = await fetchWorker(
      new Request(
        `https://api.test/verify-email?token=${encodeURIComponent(first)}`,
        { headers: { Cookie: actor.cookie } },
      ),
    );
    expect(verify.status).toBe(200);
  });

  /**
   * ⚠️ Asserts the LINK, not just that a send happened — the same reasoning as
   * test/signup.test.ts's equivalent case. `new URL(request.url).origin` would
   * be the obvious "simplification" and it is Host-header controlled: an
   * attacker could have a link to a host THEY control mailed from our own
   * confirmed sender. A send-count assertion alone would not notice.
   */
  it("mails a link on the CANONICAL origin, never the request's Host", async () => {
    const postmarkCalls = stubPostmark();
    const { actor } = await unverifiedActorWithPendingToken();

    expect((await resend(actor)).status).toBe(202);

    expect(postmarkCalls).toHaveLength(1);
    const body = postmarkBody(postmarkCalls);
    expect(String(body.TextBody)).toContain(`${CANONICAL_ORIGIN}/verify-email?token=`);
    expect(String(body.HtmlBody)).toContain(`${CANONICAL_ORIGIN}/verify-email?token=`);
    // The Host of the request that triggered the send was `api.test` — it must
    // appear nowhere in the mail. (`ALLOWED_ORIGIN` is localhost, which is
    // allowlisted for CSRF but is NOT a production origin, so the link falls
    // back to the apex — never to a link the user could not open.)
    expect(String(body.TextBody)).not.toContain("api.test");
    expect(String(body.TextBody)).not.toContain("localhost");
    expect(String(body.HtmlBody)).not.toContain("api.test");
    expect(String(body.HtmlBody)).not.toContain("localhost");
  });

  /**
   * ⚠️ PARITY WITH SIGNUP, PINNED. Both routes mail the same link and so must
   * answer "which origin?" the same way — they share `verificationLinkOrigin`
   * (src/auth/email-verify.ts) for exactly that reason. This route first shipped
   * with a private `CANONICAL_ORIGIN` copy that matched signup's SECURITY
   * property but not its BEHAVIOUR: it always mailed an apex link, so a user
   * browsing on the production origin got a link to a different host than the
   * one they were on. Reverting to a bare constant must turn this RED.
   *
   * SINGLE-HOST NOW: the app is served only from `community.thinkersjournal.com`,
   * so "keep the user on the origin they signed up from" always resolves to that
   * one host — there is no longer a second production origin (e.g. `www.`) to
   * diverge to.
   */
  it("keeps the user on the production origin — the same rule signup applies", async () => {
    const postmarkCalls = stubPostmark();
    const { actor } = await unverifiedActorWithPendingToken();

    expect(
      (await resend(actor, "https://community.thinkersjournal.com")).status,
    ).toBe(202);

    expect(String(postmarkBody(postmarkCalls).TextBody)).toContain(
      "https://community.thinkersjournal.com/verify-email?token=",
    );
  });

  it("409s ALREADY_VERIFIED for a verified session", async () => {
    const actor = await createVerifiedActor();

    const response = await resend(actor);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe(
      "ALREADY_VERIFIED",
    );
  });

  it("401s with no session", async () => {
    // ⚠️ SESSION-REQUIRED, not email-in-the-body. An unauthenticated
    // "resend to this address" endpoint is a mail-bombing gun aimed at any
    // address an attacker names, AND an enumeration oracle.
    const response = await fetchWorker(
      new Request("https://api.test/auth/resend-verification", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("403s without a CSRF token", async () => {
    const actor = await createUnverifiedActor();

    const response = await fetchWorker(
      new Request("https://api.test/auth/resend-verification", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, Cookie: actor.cookie },
      }),
    );

    expect(response.status).toBe(403);
  });

  /**
   * `RESEND_LIMITER` is 3/60s (wrangler.jsonc) and the local pool REALLY
   * enforces it. Keyed on the session's user (src/routes/resend-verification.ts) —
   * a single unverified actor's own repeated resends must hit the ceiling.
   */
  it(
    "429s past the limiter",
    async () => {
      stubPostmark();
      const actor = await createUnverifiedActor();
      await awaitLimiterBurstWindow();

      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await resend(actor)).status);
      }

      expect(statuses).toContain(429);
    },
    // `awaitLimiterBurstWindow` may hold the burst for up to ~10s waiting for a
    // clean window, which does not fit vitest's 5s default. NOT a flake-hiding
    // timeout bump: the wait is bounded and deliberate.
    60_000,
  );
});
