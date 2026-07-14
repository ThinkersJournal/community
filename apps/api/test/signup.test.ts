import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";

/**
 * Task 14 — `POST /auth/signup`, the route that composes every auth primitive
 * built so far (zod validation -> rate limit -> Turnstile -> origin -> dup
 * check -> tx -> verification email -> epoch -> session).
 *
 * Runs in the POOL project (real workerd): needs `SESSIONS` KV,
 * `HYPERDRIVE_FRESH`, `USER_SECURITY` (DO) and `SIGNUP_LIMITER`.
 *
 * ⚠️ Emails are UNIQUE PER RUN (`crypto.randomUUID()`): the test DB persists
 * across runs, and a fixed address would collide with the previous run's row.
 * Uniqueness doubles as rate-limit isolation — `SIGNUP_LIMITER`'s key is
 * `ip + ':' + email` and the limiter is REAL here (5/60s), so a shared email
 * would let one test's requests exhaust another's quota.
 */

/** An allowlisted origin (src/auth/csrf.ts) — signup 403s without one. */
const ORIGIN = "https://thinkersjournal.com";

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

function validBody(email: string, password: string = VALID_PASSWORD) {
  return { email, password, turnstileToken: "dummy-turnstile-token" };
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

    // And the verification email was sent.
    expect(postmarkCalls).toHaveLength(1);
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
  it("429s once over the rate limit (5/60s per ip+email)", async () => {
    stubFetch(false);
    const email = uniqueEmail();
    const body = validBody(email);

    for (let i = 0; i < 5; i++) {
      expect((await signup(body)).status).toBe(403);
    }

    expect((await signup(body)).status).toBe(429);
  });

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
