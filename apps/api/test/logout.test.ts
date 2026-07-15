import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import worker from "../src";
import { envWithBrokenBump } from "./helpers/broken-bump";
import { csrfTokenFor } from "../src/auth/csrf";
import { createSession, readSession } from "../src/auth/session";
import { withClient } from "../src/db/client";

import type { SessionData } from "@thinkersjournal/shared";

/**
 * Task 17 — `POST /auth/logout` and `POST /auth/logout-all`.
 *
 * Both routes run the FULL mutating pipeline (src/auth/pipeline.ts: origin ->
 * session -> CSRF -> epoch) but deliberately OPT OUT of `requireVerifiedEmail`
 * — an unverified user must still be able to end their own session. `logout`
 * destroys only the current session; `logout-all` additionally bumps the
 * user's security epoch (src/durable-objects/UserSecurityDO.ts), which revokes
 * EVERY outstanding session for that user, not just the one making the call.
 *
 * Runs in the POOL project (real workerd): real `SESSIONS` KV, real
 * `HYPERDRIVE_FRESH` Postgres, and a real `USER_SECURITY` Durable Object.
 */

// `users.password_hash` is NOT NULL — a valid PHC-encoded argon2id string.
// No password is ever verified here (sessions are minted directly via
// `createSession`, the same primitive `POST /auth/login` uses), so this
// value's only job is to satisfy the column.
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZGlnZXN0";

/** An origin in `checkOrigin`'s allowlist (src/auth/csrf.ts). */
const ALLOWED_ORIGIN = "http://localhost:8787";

/** Rows created by a test, deleted in `afterEach`. */
const createdUserIds: string[] = [];

/**
 * INSERT a user with a per-run-unique email; returns its id. `verified`
 * controls `email_verified_at`, i.e. whether this user would be blocked by
 * the soft email-verification gate (Task 13) on a CONTENT route — logout must
 * NOT care either way.
 */
async function insertUser(verified: boolean): Promise<string> {
  const ctx = createExecutionContext();
  const email = `t17_${crypto.randomUUID()}@example.com`;
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, $2, ${verified ? "now()" : "NULL"}) RETURNING id`,
      [email, PASSWORD_HASH],
    );
    return rows[0].id as string;
  });
  await waitOnExecutionContext(ctx);
  createdUserIds.push(id);
  return id;
}

interface Authed {
  /** The raw `tj_session` cookie token. */
  token: string;
  /** The value the client must echo in `X-CSRF-Token` for this session. */
  csrfToken: string;
}

/**
 * Mint a real session for `userId`, stamped with the user's CURRENT epoch read
 * from the Durable Object — exactly what `POST /auth/login` does. Stamping
 * the real epoch (rather than a hardcoded number) is what makes the
 * logout-all revocation assertions below meaningful: session B starts valid,
 * and only `bumpEpoch()` (triggered by session A's logout-all) makes it stale.
 */
async function authenticate(userId: string): Promise<Authed> {
  const securityEpoch = await env.USER_SECURITY.getByName(userId).getEpoch();
  const data: SessionData = {
    userId,
    roles: ["member"],
    securityEpoch,
    csrfSecret: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  const { cookie } = await createSession(env, data);
  const match = /^tj_session=([^;]*)/.exec(cookie);
  if (match === null) {
    throw new Error(`cookie did not match expected shape: ${cookie}`);
  }
  return { token: match[1]!, csrfToken: await csrfTokenFor(data) };
}

/** A fully valid POST to `path`: session cookie + allowed Origin + CSRF token. */
function authedRequest(
  path: string,
  authed: Authed,
  overrides: { origin?: string | null; csrfToken?: string | null } = {},
): Request {
  const headers = new Headers({ Cookie: `tj_session=${authed.token}` });

  const origin = "origin" in overrides ? overrides.origin : ALLOWED_ORIGIN;
  if (origin !== null && origin !== undefined) {
    headers.set("Origin", origin);
  }

  const csrfToken =
    "csrfToken" in overrides ? overrides.csrfToken : authed.csrfToken;
  if (csrfToken !== null && csrfToken !== undefined) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  return new Request(`https://api.test${path}`, { method: "POST", headers });
}

/** Drive the Worker through a full request lifecycle. */
async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Drive the Worker against a PATCHED `env` — the seam used to fault-inject the
 * `USER_SECURITY` DO. `src/index.ts` does not catch handler errors, so a route
 * that throws REJECTS here rather than returning a 500.
 */
async function fetchWorkerWithEnv(
  request: Request,
  patchedEnv: Env,
): Promise<Response> {
  const ctx = createExecutionContext();
  try {
    return await worker.fetch(request, patchedEnv, ctx);
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

/** A bare probe request carrying only `token`'s cookie — no Origin/CSRF. */
function cookieProbe(token: string): Request {
  return new Request("https://api.test/", {
    headers: { Cookie: `tj_session=${token}` },
  });
}

beforeEach(async () => {
  // Isolate SESSIONS across tests within this pool file (isolatedStorage was
  // removed, so KV contents persist across tests otherwise).
  const { keys } = await env.SESSIONS.list();
  await Promise.all(keys.map((k) => env.SESSIONS.delete(k.name)));
});

afterEach(async () => {
  if (createdUserIds.length > 0) {
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUserIds]),
    );
    await waitOnExecutionContext(ctx);
    createdUserIds.length = 0;
  }
});

describe("POST /auth/logout", () => {
  it("200s with a valid session, clears the cookie, and destroys the KV record", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    const response = await fetchWorker(authedRequest("/auth/logout", authed));

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("tj_session=");

    // The KV record is really gone, not merely rejected client-side.
    expect(await readSession(env, cookieProbe(authed.token))).toBeNull();

    // A subsequent MUTATING request with the same (now-dead) cookie -> 401.
    const again = await fetchWorker(authedRequest("/auth/logout", authed));
    expect(again.status).toBe(401);
  });

  it("an UNVERIFIED user can still log out -> 200, not 403 EMAIL_NOT_VERIFIED", async () => {
    const userId = await insertUser(false);
    const authed = await authenticate(userId);

    const response = await fetchWorker(authedRequest("/auth/logout", authed));

    expect(response.status).toBe(200);
  });

  it("403s a valid session with a missing X-CSRF-Token", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    const response = await fetchWorker(
      authedRequest("/auth/logout", authed, { csrfToken: null }),
    );

    expect(response.status).toBe(403);
  });

  it("403s a valid session with a WRONG X-CSRF-Token", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    const response = await fetchWorker(
      authedRequest("/auth/logout", authed, { csrfToken: "f".repeat(64) }),
    );

    expect(response.status).toBe(403);
  });

  it("403s an otherwise-perfect request from a disallowed Origin", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    const response = await fetchWorker(
      authedRequest("/auth/logout", authed, { origin: "https://evil.example" }),
    );

    expect(response.status).toBe(403);
  });
});

describe("POST /auth/logout-all", () => {
  it("bumps the user's security epoch and revokes EVERY outstanding session, including its own", async () => {
    const userId = await insertUser(true);
    // Two independent sessions for the SAME user — e.g. two devices/browsers.
    const sessionA = await authenticate(userId);
    const sessionB = await authenticate(userId);

    const epochBefore = await env.USER_SECURITY.getByName(userId).getEpoch();

    const response = await fetchWorker(
      authedRequest("/auth/logout-all", sessionA),
    );
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("Max-Age=0");

    // The epoch actually incremented.
    const epochAfter = await env.USER_SECURITY.getByName(userId).getEpoch();
    expect(epochAfter).toBe(epochBefore + 1);

    // Session A (the caller) is destroyed in KV.
    expect(await readSession(env, cookieProbe(sessionA.token))).toBeNull();

    // Session B — a DIFFERENT, pre-existing session for the same user, never
    // itself logged out — must now be rejected on its NEXT MUTATING request:
    // its snapshotted `securityEpoch` is stale against the bumped DO value.
    // (Its KV record may still exist; the epoch check is what dooms it.)
    const bResponse = await fetchWorker(
      authedRequest("/auth/logout", sessionB),
    );
    expect(bResponse.status).toBe(401);
  });

  /**
   * ⚠️ REVOKE-THEN-DESTROY — the ordering src/routes/logout.ts's header calls
   * the fail-safe direction, and which until now was pinned by NOTHING.
   *
   * `logout-all` does two things that can fail INDEPENDENTLY: it bumps the epoch
   * (a Durable Object call, revoking every session for the user) and it destroys
   * the caller's own session (a KV delete). On the SUCCESS path both orderings
   * are indistinguishable, so only a FAILING bump can tell them apart — which is
   * why this test injects one. Inverting the route to destroy-then-bump left the
   * whole file passing 9/9 before this existed.
   *
   * The two orderings under a failing bump:
   *   • bump, then destroy (as built) -> nothing happened. The caller's session
   *     is INTACT and still valid, the request visibly fails, and a retry can
   *     still achieve the logout. Fail-safe.
   *   • destroy, then bump (inverted) -> the caller's own session is gone, but
   *     the bump never landed, so EVERY OTHER session — the entire point of "log
   *     out everywhere" — survives. The user is told the request failed while
   *     being left with the false impression they may be logged out, and the
   *     sessions they were trying to kill are exactly the ones that lived.
   *
   * This is a LOWER class than signup's equivalent (there, the inverted order is
   * a silent, permanent account takeover; here it is a visible 500 that grants an
   * attacker nothing and is recoverable by retrying) — but it is the same
   * structural blindness, and it is cheap to close.
   *
   * Swapping src/routes/logout.ts to destroy-then-bump must turn this RED
   * (mutation-verified).
   */
  it("leaves the caller's session INTACT if logout-all's epoch bump fails", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);
    const epochBefore = await env.USER_SECURITY.getByName(userId).getEpoch();

    // The failure is VISIBLE, not swallowed — and asserting on the INJECTED
    // fault's own message is what stops this test passing vacuously: an
    // unrelated error (or no error at all) would not match.
    await expect(
      fetchWorkerWithEnv(
        authedRequest("/auth/logout-all", authed),
        envWithBrokenBump(),
      ),
    ).rejects.toThrow(/bumpEpoch/);

    // Nothing happened: the epoch did not move ...
    expect(await env.USER_SECURITY.getByName(userId).getEpoch()).toBe(
      epochBefore,
    );

    // ... and the caller's session still exists and still WORKS, so the logout
    // they asked for is still achievable by retrying. Under destroy-then-bump
    // this session is already gone while every OTHER session survives.
    expect(
      await readSession(env, cookieProbe(authed.token)),
      "logout-all destroyed the caller's session before the bump that failed — the sessions it was meant to revoke are the ones that survived",
    ).not.toBeNull();
    expect((await fetchWorker(authedRequest("/auth/logout", authed))).status).toBe(
      200,
    );
  });

  it("an UNVERIFIED user can still log out everywhere -> 200, not 403 EMAIL_NOT_VERIFIED", async () => {
    const userId = await insertUser(false);
    const authed = await authenticate(userId);

    const response = await fetchWorker(
      authedRequest("/auth/logout-all", authed),
    );

    expect(response.status).toBe(200);
  });

  it("403s a valid session with a missing X-CSRF-Token", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    const response = await fetchWorker(
      authedRequest("/auth/logout-all", authed, { csrfToken: null }),
    );

    expect(response.status).toBe(403);
  });

  it("403s an otherwise-perfect request from a disallowed Origin", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    const response = await fetchWorker(
      authedRequest("/auth/logout-all", authed, {
        origin: "https://evil.example",
      }),
    );

    expect(response.status).toBe(403);
  });
});
