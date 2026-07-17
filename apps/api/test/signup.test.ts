import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { envWithBrokenBump } from "./helpers/broken-bump";
import { awaitLimiterBurstWindow } from "./helpers/limiter-window";
import { TEST_LAST_TOKEN_KEY } from "../src/auth/email-verify";
import { withClient } from "../src/db/client";

/**
 * Task 14 — `POST /auth/signup`, the route that composes every auth primitive
 * built so far (zod validation -> rate limit -> Turnstile -> origin -> dup
 * check -> epoch bump -> tx -> verification email -> epoch -> session).
 *
 * Runs in the POOL project (real workerd): needs `SESSIONS` KV,
 * `HYPERDRIVE_FRESH`, `USER_SECURITY` (DO) and `SIGNUP_LIMITER`.
 *
 * ⚠️ Emails are UNIQUE PER RUN (`crypto.randomUUID()`): the test DB persists
 * across runs, and a fixed address would collide with the previous run's row.
 * Uniqueness doubles as rate-limit isolation — the route consumes TWO
 * `SIGNUP_LIMITER` buckets, `<ip>:<email>` and `email:<email>`, both keyed on
 * the email, and the limiter is REAL here (5/60s each), so a shared address
 * would let one test's requests exhaust another's quota.
 */

/** An allowlisted origin (src/auth/csrf.ts) — signup 403s without one. */
const ORIGIN = "https://thinkersjournal.com";

/**
 * The origin every emailed verification link must be built on (production only —
 * see `verificationLinkOrigin` in src/auth/email-verify.ts, which BOTH mailing
 * routes share). NOT derived from the request URL, and NOT every origin
 * `checkOrigin` accepts.
 */
const CANONICAL_ORIGIN = "https://thinkersjournal.com";

const VALID_PASSWORD = "correct-horse-battery-staple";

/** Emails created by a test, deleted in `afterEach` (profiles cascade). */
const createdEmails: string[] = [];

/** A per-run-unique address, registered for cleanup. */
function uniqueEmail(): string {
  const email = `t14_${crypto.randomUUID()}@example.com`;
  createdEmails.push(email);
  return email;
}

/** Run a query through the FRESH (cache-disabled) binding. */
async function query(
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const result = await c.query(sql, params);
    return result.rows as Record<string, unknown>[];
  });
  await waitOnExecutionContext(ctx);
  return rows;
}

/**
 * Stub the global `fetch` for BOTH outbound calls signup makes, dispatching on
 * the request URL:
 *   • Turnstile `siteverify` (src/auth/turnstile.ts) -> `{ success }`
 *   • Postmark `/email`      (src/auth/email-verify.ts) -> `{ ErrorCode: 0 }`
 * Any other URL throws, so an unexpected outbound call fails loudly rather than
 * silently returning a bogus body. Restored in `afterEach` — a leaked stub
 * would break sibling pool test files sharing this workerd isolate.
 *
 * Returns the captured Postmark request inits.
 */
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

function signupRequest(
  body: unknown,
  headers: Record<string, string> = { Origin: ORIGIN },
): Request {
  return new Request("https://api.test/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** POST /auth/signup through the Worker's router. */
async function signup(
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(signupRequest(body, headers), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * POST /auth/signup against a PATCHED `env` — the seam used to fault-inject the
 * `USER_SECURITY` DO. `src/index.ts` does not catch handler errors, so a signup
 * that throws REJECTS here rather than returning a 500.
 */
async function signupWithEnv(body: unknown, patchedEnv: Env): Promise<Response> {
  const ctx = createExecutionContext();
  try {
    return await worker.fetch(signupRequest(body), patchedEnv, ctx);
  } finally {
    await waitOnExecutionContext(ctx);
  }
}


function validBody(email: string, password: string = VALID_PASSWORD) {
  return { email, password, turnstileToken: "dummy-turnstile-token" };
}

/** The `Cookie` header value carrying the session a signup response just set. */
function cookieFrom(response: Response): string {
  return response.headers.get("Set-Cookie")!.split(";")[0]!;
}

/** The parsed Postmark JSON body of the Nth captured send. */
function postmarkBody(calls: RequestInit[], index = 0): Record<string, unknown> {
  return JSON.parse(String(calls[index]!.body)) as Record<string, unknown>;
}

/**
 * The RAW verification token signup just issued, read from the TEST-ONLY stash
 * (`TEST_ROUTES === "1"`; src/auth/email-verify.ts). Holds only the MOST RECENT
 * token, so read it immediately after the signup whose token you want.
 */
async function lastVerifyToken(): Promise<string> {
  const token = await env.SESSIONS.get(TEST_LAST_TOKEN_KEY);
  expect(token).not.toBeNull();
  return token!;
}

/** `GET /verify-email?token=…` through the Worker's router, optionally signed in. */
async function verifyEmail(token: string, cookie?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(
      `https://api.test/verify-email?token=${encodeURIComponent(token)}`,
      cookie === undefined ? undefined : { headers: { Cookie: cookie } },
    ),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** The `users.id` for `email`. */
async function userIdFor(email: string): Promise<string> {
  const rows = await query("SELECT id FROM users WHERE email = $1", [email]);
  expect(rows).toHaveLength(1);
  return String(rows[0]!.id);
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

  if (createdEmails.length > 0) {
    await query("DELETE FROM users WHERE email = ANY($1::citext[])", [
      createdEmails,
    ]);
    createdEmails.length = 0;
  }
});

describe("POST /auth/signup", () => {
  it("creates the user, profile, session cookie and verification token", async () => {
    const postmarkCalls = stubFetch(true);
    const email = uniqueEmail();

    const response = await signup(validBody(email));

    expect(response.status).toBe(201);

    // The session cookie is set from `createSession`'s Set-Cookie.
    const cookie = response.headers.get("Set-Cookie");
    expect(cookie).toContain("tj_session=");

    // A `users` row exists ...
    const users = await query(
      "SELECT id, password_hash, email_verified_at FROM users WHERE email = $1",
      [email],
    );
    expect(users).toHaveLength(1);
    // ... unverified (verification is the emailed link's job) ...
    expect(users[0]!.email_verified_at).toBeNull();
    // ... with an Argon2id PHC hash — never the plaintext password.
    expect(String(users[0]!.password_hash)).toMatch(/^\$argon2id\$/);
    expect(String(users[0]!.password_hash)).not.toContain(VALID_PASSWORD);

    // ... and a `profiles` row exists for it (username is GENERATED — signup
    // takes no username field; user-chosen usernames are M1).
    const profiles = await query(
      "SELECT username FROM profiles WHERE user_id = $1",
      [users[0]!.id],
    );
    expect(profiles).toHaveLength(1);
    expect(String(profiles[0]!.username)).toMatch(/^[a-z0-9_]+$/);

    // A verification token was stored in KV (hashed — see src/auth/email-verify.ts).
    const { keys } = await env.SESSIONS.list({ prefix: "verify-email:" });
    expect(keys).toHaveLength(1);

    // And the verification email was sent ...
    expect(postmarkCalls).toHaveLength(1);

    // ... carrying a link on the CANONICAL production origin.
    //
    // ⚠️ Asserting the LINK, not just that a send happened: the origin here is
    // the file's key security decision. `new URL(request.url).origin` would be
    // the obvious "simplification", and it is Host-header controlled — an
    // attacker could put a link to a host THEY control into mail sent from our
    // own confirmed sender. A send-count assertion alone would not notice.
    const body = postmarkBody(postmarkCalls);
    expect(String(body.TextBody)).toContain(
      `${CANONICAL_ORIGIN}/verify-email?token=`,
    );
    expect(String(body.HtmlBody)).toContain(
      `${CANONICAL_ORIGIN}/verify-email?token=`,
    );
    // The Host of the request that triggered the send was `api.test` — it must
    // appear nowhere in the mail.
    expect(String(body.TextBody)).not.toContain("api.test");
    expect(String(body.HtmlBody)).not.toContain("api.test");
  });

  /**
   * With no `Origin`, `checkOrigin` falls back to `Referer` — but the emailed
   * link does NOT: it pins `CANONICAL_ORIGIN`.
   */
  it("builds the emailed link on CANONICAL_ORIGIN when the request has only a Referer", async () => {
    const postmarkCalls = stubFetch(true);
    const email = uniqueEmail();

    const response = await signup(validBody(email), {
      Referer: `${ORIGIN}/signup`,
    });

    expect(response.status).toBe(201);
    expect(String(postmarkBody(postmarkCalls).TextBody)).toContain(
      `${CANONICAL_ORIGIN}/verify-email?token=`,
    );
  });

  /**
   * `ALLOWED_ORIGINS` (src/auth/csrf.ts) includes `http://localhost:8787` for
   * dev, and that is fine for CSRF — a remote attacker's browser cannot forge
   * that Origin against a developer's machine. But a NON-BROWSER client (curl, a
   * script) can set any Origin it likes against production, so honoring it for
   * the emailed link would deliver an unusable localhost link into a real
   * victim's inbox: verification-denial griefing. The link origin is therefore
   * restricted to PRODUCTION origins only.
   */
  it("never builds the emailed link on a non-production origin, even an allowlisted one", async () => {
    const postmarkCalls = stubFetch(true);
    const email = uniqueEmail();

    const response = await signup(validBody(email), {
      Origin: "http://localhost:8787",
    });

    // The origin is allowlisted, so the signup itself still succeeds ...
    expect(response.status).toBe(201);

    // ... but the emailed link points at production, NOT localhost.
    const body = postmarkBody(postmarkCalls);
    expect(String(body.TextBody)).toContain(
      `${CANONICAL_ORIGIN}/verify-email?token=`,
    );
    expect(String(body.TextBody)).not.toContain("localhost");
    expect(String(body.HtmlBody)).not.toContain("localhost");
  });

  it("409s on a duplicate VERIFIED email", async () => {
    stubFetch(true);
    const email = uniqueEmail();

    expect((await signup(validBody(email))).status).toBe(201);
    await query("UPDATE users SET email_verified_at = now() WHERE email = $1", [
      email,
    ]);

    const response = await signup(validBody(email));

    expect(response.status).toBe(409);
  });

  /**
   * ⚠️ THE GUARD ON THE UPSERT — why `ON CONFLICT (email) DO UPDATE` carries a
   * `WHERE users.email_verified_at IS NULL`.
   *
   * The 409 above pins the STATUS; this pins the CONSEQUENCE, and they are not
   * the same assertion. An UNGUARDED `DO UPDATE SET password_hash =
   * EXCLUDED.password_hash` — the obvious way to make signup atomic, and the
   * form M0 explicitly rejected — would let ANY stranger's signup on a VERIFIED
   * address overwrite that account's password: a one-request, no-authentication
   * account takeover of a proven owner. The status assertion alone would notice
   * (409 -> 201), but nothing would say WHY it mattered.
   *
   * Deleting the `WHERE` from the upsert in src/routes/signup.ts must turn this
   * RED (mutation-verified).
   */
  it("never overwrites a VERIFIED account's password (the upsert's WHERE guard)", async () => {
    stubFetch(true);
    const email = uniqueEmail();

    expect((await signup(validBody(email))).status).toBe(201);
    await query("UPDATE users SET email_verified_at = now() WHERE email = $1", [
      email,
    ]);
    const before = await query(
      "SELECT id, password_hash FROM users WHERE email = $1",
      [email],
    );
    const userId = String(before[0]!.id);
    const epochBefore = await env.USER_SECURITY.getByName(userId).getEpoch();

    const response = await signup(validBody(email, "attacker-password-here"));

    expect(response.status).toBe(409);
    // No session was minted for the stranger ...
    expect(response.headers.get("Set-Cookie")).toBeNull();

    const after = await query(
      "SELECT password_hash, email_verified_at FROM users WHERE email = $1",
      [email],
    );
    // ... the owner's password is UNTOUCHED — this is the whole point of the
    // guard: zero rows came back, so nothing was written ...
    expect(after[0]!.password_hash).toBe(before[0]!.password_hash);
    // ... the account is still verified ...
    expect(after[0]!.email_verified_at).not.toBeNull();
    // ... and the owner's live sessions were NOT revoked. A 409 must be inert:
    // an unguarded upsert would have bumped here (it would have looked like a
    // re-signup), letting a stranger log the real owner out at will.
    expect(await env.USER_SECURITY.getByName(userId).getEpoch()).toBe(
      epochBefore,
    );
  });

  /**
   * An UNVERIFIED account has no proven owner, so a later signup TAKES IT OVER
   * rather than 409ing (which would leak that the address is registered) or
   * 500ing on the `users.email` unique violation.
   */
  it("re-signs-up a duplicate UNVERIFIED email (201, one user, one profile)", async () => {
    stubFetch(true);
    const email = uniqueEmail();

    expect((await signup(validBody(email))).status).toBe(201);
    const before = await query("SELECT id, password_hash FROM users WHERE email = $1", [
      email,
    ]);
    expect(before).toHaveLength(1);

    const response = await signup(validBody(email, "a-completely-different-password"));

    expect(response.status).toBe(201);
    expect(response.headers.get("Set-Cookie")).toContain("tj_session=");

    // Exactly ONE users row — the SAME id, with a CHANGED password hash.
    const after = await query(
      "SELECT id, password_hash FROM users WHERE email = $1",
      [email],
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.password_hash).not.toBe(before[0]!.password_hash);

    // Exactly ONE profiles row — no duplicate profile was inserted.
    const profiles = await query(
      "SELECT user_id FROM profiles WHERE user_id = $1",
      [after[0]!.id],
    );
    expect(profiles).toHaveLength(1);
  });

  /**
   * Re-signup changes the account's password, so every session issued against
   * the OLD one must die. See the ordering note at step 6 of
   * src/routes/signup.ts.
   */
  it("bumps the security epoch on a re-signup, revoking the previous claimant's sessions", async () => {
    stubFetch(true);
    const email = uniqueEmail();

    expect((await signup(validBody(email))).status).toBe(201);
    const userId = await userIdFor(email);
    const epochBefore = await env.USER_SECURITY.getByName(userId).getEpoch();

    expect(
      (await signup(validBody(email, "a-completely-different-password"))).status,
    ).toBe(201);

    expect(await env.USER_SECURITY.getByName(userId).getEpoch()).toBe(
      epochBefore + 1,
    );
  });

  /**
   * The NEW session must carry the POST-bump epoch — reading the epoch before
   * the bump would stamp the session with a value the bump immediately
   * invalidates, logging the new owner straight back out.
   */
  it("gives the re-signup's own session a live (post-bump) epoch", async () => {
    stubFetch(true);
    const email = uniqueEmail();

    expect((await signup(validBody(email))).status).toBe(201);
    const response = await signup(
      validBody(email, "a-completely-different-password"),
    );
    expect(response.status).toBe(201);

    // The clearest proof the new session is live: it can verify the account.
    const verify = await verifyEmail(
      await lastVerifyToken(),
      cookieFrom(response),
    );
    expect(verify.status).toBe(200);
  });

  /**
   * ⚠️ REVOKE-THEN-MUTATE — the ORDER half of the account-takeover fix, and the
   * property the atomic upsert is most likely to drop silently.
   *
   * A re-signup does TWO things: it revokes the displaced claimant's sessions
   * (`bumpEpoch`) and it changes the password. The bump is a Durable Object call
   * and is therefore NOT part of the Postgres transaction — so the two can fail
   * independently, and only one of the two orderings is safe:
   *
   *   • bump, then commit  -> a crash leaves the OLD password live with sessions
   *                           revoked. Harmless: the displaced party re-logs in.
   *   • commit, then bump  -> a crash leaves the NEW password live with the
   *                           victim's session S1 UNREVOKED and its epoch still
   *                           MATCHING. That is exactly the takeover state the
   *                           regression test below exists to prevent: the
   *                           victim's own click on T1 then verifies an account
   *                           holding the attacker's password. `bumpEpoch` is
   *                           load-bearing precisely WHEN it fails.
   *
   * So the bump is issued INSIDE the transaction, BEFORE the COMMIT. What makes
   * that correct is not durability ordering but VISIBILITY: no observer can ever
   * see the new password unless the bump already succeeded.
   *
   * The window only exists when the bump fails, so it cannot be observed without
   * injecting the fault. Moving the bump after the COMMIT (or after the
   * `withClient` returns) must turn this RED (mutation-verified).
   */
  it("leaves the OLD password live if a re-signup's epoch bump fails", async () => {
    stubFetch(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const email = uniqueEmail();

    expect((await signup(validBody(email))).status).toBe(201);
    const before = await query(
      "SELECT password_hash FROM users WHERE email = $1",
      [email],
    );

    // The re-signup cannot revoke the victim's sessions -> it must not land.
    await expect(
      signupWithEnv(
        validBody(email, "attacker-password-here"),
        envWithBrokenBump(),
      ),
    ).rejects.toThrow(/bumpEpoch/);

    // The takeover did not HALF-land: the password the surviving sessions were
    // issued against is still the one the account holds.
    const after = await query(
      "SELECT password_hash FROM users WHERE email = $1",
      [email],
    );
    expect(
      after[0]!.password_hash,
      "the new password committed even though the epoch bump failed — the displaced claimant's session is now live against a password they do not know",
    ).toBe(before[0]!.password_hash);
  });

  /**
   * The profile insert is `ON CONFLICT (user_id) DO NOTHING` and runs on EVERY
   * path, not just the insert — so a `users` row that somehow has no profile
   * heals on the next signup instead of the re-signup silently assuming one is
   * already there. (The conflict target is `user_id`; a `username` collision is
   * a DIFFERENT index and still retries under the savepoint.)
   */
  it("heals a missing profile row on a re-signup", async () => {
    stubFetch(true);
    const email = uniqueEmail();

    expect((await signup(validBody(email))).status).toBe(201);
    const userId = await userIdFor(email);
    await query("DELETE FROM profiles WHERE user_id = $1", [userId]);

    expect(
      (await signup(validBody(email, "a-completely-different-password"))).status,
    ).toBe(201);

    const profiles = await query(
      "SELECT username FROM profiles WHERE user_id = $1",
      [userId],
    );
    expect(profiles).toHaveLength(1);
  });

  it("issues a session and token that verify the account end to end", async () => {
    stubFetch(true);
    const email = uniqueEmail();

    const response = await signup(validBody(email));
    expect(response.status).toBe(201);
    const token = await lastVerifyToken();
    const cookie = cookieFrom(response);

    const verify = await verifyEmail(token, cookie);

    expect(verify.status).toBe(200);
    const rows = await query(
      "SELECT email_verified_at FROM users WHERE email = $1",
      [email],
    );
    expect(rows[0]!.email_verified_at).not.toBeNull();

    // Still ONE-TIME on success: the same link cannot be replayed.
    expect((await verifyEmail(token, cookie)).status).toBe(400);
  });

  /**
   * ⚠️ THE ACCOUNT-TAKEOVER REGRESSION — the reason `GET /verify-email` requires
   * authentication at all. Read the header of src/routes/verify-email.ts first.
   *
   * The chain this pins:
   *   1. The victim signs up  -> session S1, token T1 emailed to the victim.
   *   2. An attacker re-signs-up the SAME (still unverified) address: the
   *      account's password becomes the ATTACKER'S, and T2 is emailed to the
   *      victim too.
   *   3. The victim clicks T1 — the mail they were expecting.
   *
   * Historically step 3 stamped `email_verified_at` unconditionally, so the
   * VICTIM'S OWN CLICK promoted an account holding the ATTACKER'S password to
   * verified: the attacker ended up owning a verified account and the victim's
   * password no longer worked. Note the attacker never touches the link — the
   * victim's legitimate click is the exploit.
   *
   * Both halves of the fix are asserted, because either alone is insufficient:
   *   (a) the re-signup BUMPED the epoch, making S1 stale, and
   *   (b) T1 + S1 no longer verifies.
   *
   * Removing the `bumpEpoch()` in signup, or the epoch check in verify-email,
   * must turn this test RED. Both mutations were run; both redden it here.
   */
  it("does not let a victim's own verification link verify an account an attacker took over", async () => {
    stubFetch(true);
    const email = uniqueEmail();

    // 1. The victim signs up: session S1, verification token T1.
    const victim = await signup(validBody(email, "victim-password-here"));
    expect(victim.status).toBe(201);
    const s1 = cookieFrom(victim);
    // Read T1 NOW — the stash holds only the most recent token, and the attacker
    // is about to issue T2 over it.
    const t1 = await lastVerifyToken();
    const userId = await userIdFor(email);
    const epochBefore = await env.USER_SECURITY.getByName(userId).getEpoch();

    // 2. The attacker re-signs-up the same still-unverified address.
    const attacker = await signup(validBody(email, "attacker-password-here"));
    expect(attacker.status).toBe(201);

    // (a) The epoch bumped, so S1 — issued against the victim's password — is
    //     now stale. This is what the verify-email epoch check keys off.
    expect(await env.USER_SECURITY.getByName(userId).getEpoch()).toBe(
      epochBefore + 1,
    );

    // (b) The victim clicks T1 while still holding S1: NO verification.
    const clicked = await verifyEmail(t1, s1);
    expect(clicked.status).toBe(401);
    expect(await clicked.json()).toEqual({ code: "LOGIN_REQUIRED" });

    // The account is STILL UNVERIFIED — the takeover did not complete.
    const rows = await query(
      "SELECT email_verified_at FROM users WHERE id = $1",
      [userId],
    );
    expect(rows[0]!.email_verified_at).toBeNull();
  });

  it("400s a password shorter than 12 characters (zod)", async () => {
    stubFetch(true);
    const email = uniqueEmail();

    const response = await signup(validBody(email, "short"));

    expect(response.status).toBe(400);
    // Rejected before any DB write.
    expect(await query("SELECT id FROM users WHERE email = $1", [email])).toHaveLength(
      0,
    );
  });

  it("400s an invalid email (zod)", async () => {
    stubFetch(true);

    const response = await signup(validBody("not-an-email"));

    expect(response.status).toBe(400);
  });

  it("403s when Turnstile blocks the request", async () => {
    stubFetch(false);
    const email = uniqueEmail();

    const response = await signup(validBody(email));

    expect(response.status).toBe(403);
    // Turnstile runs BEFORE any DB touch — no user row was created.
    expect(await query("SELECT id FROM users WHERE email = $1", [email])).toHaveLength(
      0,
    );
  });

  it("403s a request from a non-allowlisted origin", async () => {
    stubFetch(true);
    const email = uniqueEmail();

    const response = await signup(validBody(email), { Origin: "https://evil.test" });

    expect(response.status).toBe(403);
    // The origin check runs BEFORE any DB touch.
    expect(await query("SELECT id FROM users WHERE email = $1", [email])).toHaveLength(
      0,
    );
  });

  /**
   * `SIGNUP_LIMITER` is 5/60s and the local pool REALLY enforces it. Turnstile
   * is stubbed to BLOCK so each allowed request costs a 403 (no hashing, no DB)
   * — which also proves the limiter runs BEFORE Turnstile: the 6th request is
   * rejected by the limiter, not the (also-failing) challenge.
   */
  it(
    "429s once over the rate limit (5/60s per ip+email)",
    async () => {
      stubFetch(false);
      const email = uniqueEmail();
      const body = validBody(email);
      await awaitLimiterBurstWindow();

      for (let i = 0; i < 5; i++) {
        expect((await signup(body)).status).toBe(403);
      }

      expect((await signup(body)).status).toBe(429);
    },
    // `awaitLimiterBurstWindow` may hold the burst for up to ~10s waiting for a
    // clean window, which does not fit vitest's 5s default. NOT a flake-hiding
    // timeout bump: the wait is bounded and deliberate, and the burst it guards
    // still takes well under a second.
    60_000,
  );

  /**
   * ⚠️ THE MULTI-IP CEILING — the reason signup consumes TWO limiter buckets
   * (`ip:email` AND `email`), not one.
   *
   * The `ip:email` key alone gives every IP its OWN bucket, so it bounds nothing
   * about a single ADDRESS: N IPs = N × 5 signups per window against one victim
   * address. Every one of those is a real verification email sent to a real
   * inbox from our confirmed sender — i.e. we become the mail-bomb — and, while
   * the address stays unverified, each also takes the account over and revokes
   * the previous claimant's sessions.
   *
   * Here every request carries a DIFFERENT `CF-Connecting-IP`, so the `ip:email`
   * bucket is FRESH each time and can never be what returns the 429. Only the
   * email-only bucket can.
   *
   * Turnstile is stubbed to BLOCK so each allowed request costs a cheap 403 (no
   * hashing, no DB, no mail) — the limiter counts it either way.
   *
   * Removing the `email:${email}` `enforceRateLimit` call from
   * src/routes/signup.ts must turn this test RED (mutation-verified).
   */
  it(
    "429s a single email signup-bombed from MANY DIFFERENT IPs (the ip:email bucket alone would not)",
    async () => {
      stubFetch(false);
      const email = uniqueEmail();
      const body = validBody(email);
      await awaitLimiterBurstWindow();

      // 5 attempts, each from a different IP => 5 distinct `ip:email` buckets,
      // each still holding 4 unused slots.
      for (let i = 0; i < 5; i++) {
        const response = await signup(body, {
          Origin: ORIGIN,
          "CF-Connecting-IP": `198.51.100.${i}`,
        });
        expect(
          response.status,
          `attempt ${i + 1} from a fresh IP should still reach Turnstile's 403`,
        ).toBe(403);
      }

      // The 6th, from yet another brand-new IP: its `ip:email` bucket is
      // untouched, so a 429 can ONLY come from the email-only bucket.
      const blocked = await signup(body, {
        Origin: ORIGIN,
        "CF-Connecting-IP": "198.51.100.99",
      });
      expect(
        blocked.status,
        "an address must have a ceiling regardless of source IP — the email-only limiter bucket is missing",
      ).toBe(429);
    },
    60_000,
  );

  /**
   * ⚠️ ORDER: origin check BEFORE the limiter (src/routes/signup.ts's header),
   * matching the rule src/auth/pipeline.ts states — quota is spent only by a
   * request otherwise entitled to proceed. The inverse order let a cross-site
   * page burn a victim's signup quota before the 403 it was always going to get.
   */
  it(
    "spends NO rate-limit quota on a request rejected by the origin check",
    async () => {
      stubFetch(false);
      const email = uniqueEmail();
      const body = validBody(email);

      // 10 cross-site attempts — twice SIGNUP_LIMITER's 5/60s. If the limiter
      // ran first, these would exhaust both of this email's buckets.
      for (let i = 0; i < 10; i++) {
        expect((await signup(body, { Origin: "https://evil.test" })).status).toBe(
          403,
        );
      }

      // The victim's own next attempt must still be evaluated on its merits.
      // Turnstile is stubbed to block, so the honest answer here is 403 — the
      // assertion is that it is NOT a 429.
      expect(
        (await signup(body)).status,
        "a cross-site POST burned the victim's signup quota — checkOrigin must run before the limiter",
      ).toBe(403);
    },
    60_000,
  );

  it("400s a malformed JSON body (not a 500)", async () => {
    stubFetch(true);

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json", Origin: ORIGIN },
        body: "{not json",
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
  });

  /**
   * `sendVerificationEmail` never throws (src/auth/email-verify.ts), so a
   * Postmark outage must not 500 a signup whose account already exists.
   */
  it("still 201s when the verification email fails to send", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith("https://challenges.cloudflare.com/")) {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new TypeError("postmark unreachable");
      }),
    );
    const email = uniqueEmail();

    const response = await signup(validBody(email));

    expect(response.status).toBe(201);
    expect(await query("SELECT id FROM users WHERE email = $1", [email])).toHaveLength(
      1,
    );
  });
});

/**
 * ⚠️ THE M0 CARRY-OVER: the dup-check -> INSERT race (deviation E).
 *
 * M0 did `SELECT … WHERE email = $1` and then, separately, `INSERT`. Between the
 * two sits a full Argon2id hash (~40-60ms, deliberately), so the window is not
 * theoretical — it is the widest check-then-act window in the codebase. Two
 * concurrent signups for one address both read "no row", both INSERT, and the
 * second dies on the `users_email_key` unique index: a clean rollback, but a
 * 500. It is also the one place that disobeys M0's own Global Constraint —
 * "transaction-mode pooler => all uniqueness/races via DB constraints +
 * INSERT … ON CONFLICT".
 */
describe("POST /auth/signup — concurrent same-email signups", () => {
  /**
   * ⚠️ THE ASSERTION IS "NO 500", not a specific pair of statuses. Both requests
   * may legitimately 201 (the second is a re-signup over the unverified row the
   * first just created — see the re-signup test above); which one wins is a
   * genuine race and pinning an order here would be pinning the scheduler. What
   * must NEVER happen is the unique index surfacing as a server error.
   *
   * Both requests run in ONE workerd isolate, so the interleaving is real: the
   * dup-check `await` yields, and under M0's shape both requests reached their
   * INSERT having each seen an empty table.
   */
  it("resolve to 201/409 — never a 500 from the unique index", async () => {
    stubFetch(true);
    const email = uniqueEmail();
    const body = validBody(email);

    const [a, b] = await Promise.all([signup(body), signup(body)]);

    expect(
      [a.status, b.status],
      "a concurrent same-email signup surfaced the users_email_key violation instead of resolving it",
    ).toSatisfy((statuses: number[]) =>
      statuses.every((s) => s === 201 || s === 409),
    );

    // And the constraint still did its job: exactly ONE row, ONE profile.
    const users = await query(
      "SELECT id FROM users WHERE email = $1",
      [email],
    );
    expect(users).toHaveLength(1);
    const profiles = await query(
      "SELECT user_id FROM profiles WHERE user_id = $1",
      [users[0]!.id],
    );
    expect(profiles).toHaveLength(1);
  });

  /**
   * The race must be closed WITHOUT loosening the guard: a VERIFIED address is
   * still 409, even when the duplicate signups arrive together.
   */
  it("still 409 a VERIFIED address when they arrive together", async () => {
    stubFetch(true);
    const email = uniqueEmail();

    expect((await signup(validBody(email))).status).toBe(201);
    await query("UPDATE users SET email_verified_at = now() WHERE email = $1", [
      email,
    ]);
    const before = await query(
      "SELECT password_hash FROM users WHERE email = $1",
      [email],
    );

    const body = validBody(email, "attacker-password-here");
    const [a, b] = await Promise.all([signup(body), signup(body)]);

    expect(a.status).toBe(409);
    expect(b.status).toBe(409);
    const after = await query(
      "SELECT password_hash FROM users WHERE email = $1",
      [email],
    );
    expect(after[0]!.password_hash).toBe(before[0]!.password_hash);
  });
});
