import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import worker from "../src";
import { csrfTokenFor } from "../src/auth/csrf";
import { runMutatingPipeline } from "../src/auth/pipeline";
import { createSession, readSession } from "../src/auth/session";
import { withClient } from "../src/db/client";

import type { SessionData } from "@thinkersjournal/shared";

/**
 * Task 16 — the MUTATING-REQUEST PIPELINE and epoch revocation.
 *
 * Two properties are pinned here:
 *
 *   1. REVOCATION: bumping a user's security epoch (the O(1) "log out
 *      everywhere" lever, src/durable-objects/UserSecurityDO.ts) must make
 *      every outstanding session for that user unusable for MUTATION on its
 *      very next request — 401, with the session actually destroyed in KV and
 *      a cleared cookie sent back so the browser stops replaying it. A GET
 *      with the same stale cookie still succeeds: reads carry no session
 *      requirement at all, so there is nothing for a stale epoch to revoke.
 *
 *   2. CHAIN ORDER: origin -> session -> CSRF -> epoch -> verified-email.
 *      Each step's rejection is asserted while every LATER step's input is
 *      deliberately valid, and (where the outcomes differ) an EARLIER step is
 *      given a failing input too, so a reordering flips the status code and
 *      reddens a test rather than passing silently.
 *
 * Runs in the POOL project (real workerd, no mocks): real `SESSIONS` KV, real
 * `HYPERDRIVE_FRESH` Postgres, and a real `USER_SECURITY` Durable Object.
 */

// `users.password_hash` is NOT NULL — a valid PHC-encoded argon2id string.
// This suite authenticates by minting a session directly (`createSession`, the
// same primitive `POST /auth/login` uses), so no password is ever verified
// here and this value's only job is to satisfy the column.
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZGlnZXN0";

/** An origin in `checkOrigin`'s allowlist (src/auth/csrf.ts). */
const ALLOWED_ORIGIN = "http://localhost:8787";

/** Rows created by a test, deleted in `afterEach`. */
const createdUserIds: string[] = [];

/**
 * INSERT a user with a per-run-unique email; returns its id. `verified`
 * controls `email_verified_at`, i.e. which side of the soft gate (Task 13)
 * the user lands on.
 *
 * ⚠️ ALSO INSERTS A `profiles` ROW — every real user has one (signup creates
 * both in the same transaction; see src/routes/signup.ts), and T17's
 * `POST /posts` response now resolves the author's `username` via
 * `profiles.user_id` (src/routes/posts.ts's `usernameFor`). Without this a
 * user built by this fixture is not a real user at all, and every case here
 * that reaches `POST /posts` would 500 on a data-integrity state the real
 * system never produces — a fixture gap, not a bug in the handler.
 */
async function insertUser(verified: boolean): Promise<string> {
  const ctx = createExecutionContext();
  const email = `t16_${crypto.randomUUID()}@example.com`;
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, $2, ${verified ? "now()" : "NULL"}) RETURNING id`,
      [email, PASSWORD_HASH],
    );
    const userId = rows[0].id as string;
    await c.query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [
      userId,
      `t16_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    ]);
    return userId;
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
 * from the Durable Object — exactly what `POST /auth/login` does (step 8 of
 * src/routes/login.ts). Stamping the real epoch (rather than a hardcoded
 * number) is what makes the revocation tests below meaningful: the session
 * starts valid, and only `bumpEpoch()` makes it stale.
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

/**
 * A fully valid `POST /posts`: session cookie + allowed Origin + CSRF token +
 * a body that satisfies `CreatePostInput`.
 *
 * ⚠️ THE BODY IS REQUIRED SINCE TASK 9, and its absence would be invisible here.
 * `POST /posts` is a real handler now: a bodyless request 400s (INVALID_JSON) at
 * the step AFTER the pipeline. Every case below that asserts a REJECTION (403,
 * 401) would still pass without a body — the pipeline short-circuits first — so
 * only the 201 baselines would have caught it. Those baselines are exactly what
 * makes the rejection cases meaningful ("the same request shape succeeds before
 * the bump"), so the body is what keeps this suite honest rather than an
 * incidental fix.
 *
 * A unique title per call: `posts_author_slug_key` is (author_id, slug), and the
 * handler's collision retry would mask a same-title create rather than fail —
 * but these cases are about the pipeline, so they should not lean on it.
 */
function postPosts(
  authed: Authed,
  overrides: { origin?: string | null; csrfToken?: string | null } = {},
): Request {
  const headers = new Headers({
    Cookie: `tj_session=${authed.token}`,
    "content-type": "application/json",
  });

  const origin = "origin" in overrides ? overrides.origin : ALLOWED_ORIGIN;
  if (origin !== null && origin !== undefined) {
    headers.set("Origin", origin);
  }

  const csrfToken =
    "csrfToken" in overrides ? overrides.csrfToken : authed.csrfToken;
  if (csrfToken !== null && csrfToken !== undefined) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  return new Request("https://api.test/posts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: `Epoch probe ${crypto.randomUUID()}`,
      markdownSource: "body",
    }),
  });
}

/** Drive the Worker through a full request lifecycle. */
async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
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

describe("epoch revocation", () => {
  it("bumpEpoch revokes a live session: the next POST -> 401 + cleared cookie + session gone from KV", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    // Baseline: the very same request shape SUCCEEDS before the bump, so the
    // 401 below can only be attributable to the epoch change.
    const before = await fetchWorker(postPosts(authed));
    expect(before.status).toBe(201);

    await env.USER_SECURITY.getByName(userId).bumpEpoch();

    const after = await fetchWorker(postPosts(authed));
    expect(after.status).toBe(401);

    // The cookie must be actively CLEARED, not merely rejected — otherwise the
    // browser keeps replaying a session that can never succeed again.
    const setCookie = after.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("tj_session=");

    // And `destroySession` must really have run: the KV record is gone, so the
    // stale token is dead server-side even if a client ignores the cookie.
    const probe = new Request("https://api.test/posts", {
      headers: { Cookie: `tj_session=${authed.token}` },
    });
    expect(await readSession(env, probe)).toBeNull();
  });

  /**
   * ⚠️ TASK 9 SPLIT THIS CASE IN TWO, AND THE SPLIT IS THE POINT.
   *
   * This was ONE case asserting "a GET with the SAME stale cookie -> still 200
   * (GETs skip session/epoch/CSRF)", driven against M0's `GET /posts` stub feed.
   * That route is gone, and — more importantly — its stated property is now only
   * HALF true. "GET" is no longer one category:
   *
   *   • an ANONYMOUS read (src/routes/public.ts) reads no session at all, so a
   *     stale epoch has nothing to revoke. Still 200. That is the half below.
   *   • a SESSION-BEARING read (`GET /posts/:id`) authenticates via
   *     `readCurrentSession`, which DOES check the epoch — deliberately, because
   *     a session's KV record outlives its revocation. It 401s.
   *
   * Repointing the old case at a still-200 route and calling it done would have
   * kept a green test whose NAME asserts something false, and would have left
   * the epoch check on session-bearing GETs — a security property that did not
   * exist before this task — pinned by nothing.
   */
  it("an ANONYMOUS read with the SAME stale cookie -> still 200 (it reads no session)", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    await env.USER_SECURITY.getByName(userId).bumpEpoch();

    const response = await fetchWorker(
      new Request("https://api.test/public/recent?limit=1", {
        headers: { Cookie: `tj_session=${authed.token}` },
      }),
    );

    expect(response.status).toBe(200);
  });

  it("a SESSION-BEARING read with the SAME stale cookie -> 401 + cleared cookie", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    await env.USER_SECURITY.getByName(userId).bumpEpoch();

    // Any well-formed id: `readCurrentSession` rejects before the post is ever
    // looked up, which is itself the property — a revoked session must not be
    // able to probe for the existence of a row.
    const response = await fetchWorker(
      new Request("https://api.test/posts/00000000-0000-7000-8000-000000000000", {
        headers: { Cookie: `tj_session=${authed.token}` },
      }),
    );

    expect(response.status).toBe(401);
    // Destroyed, not merely rejected — the same contract the mutating path owes.
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});

describe("mutating pipeline chain order", () => {
  it("step 1 — a missing Origin -> 403, BEFORE any session lookup (a garbage cookie still 403s, not 401s)", async () => {
    // A cookie that resolves to no session: if `readSession` ran first this
    // would be a 401. 403 proves the origin check short-circuits ahead of it.
    const response = await fetchWorker(
      new Request("https://api.test/posts", {
        method: "POST",
        headers: { Cookie: "tj_session=not-a-real-token" },
      }),
    );

    expect(response.status).toBe(403);
  });

  it("step 1 — a disallowed Origin -> 403 even with an otherwise perfect request", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    const response = await fetchWorker(
      postPosts(authed, { origin: "https://evil.example" }),
    );

    expect(response.status).toBe(403);
  });

  it("step 2 — no session -> 401 (with an allowed Origin, so step 1 passes)", async () => {
    const response = await fetchWorker(
      new Request("https://api.test/posts", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("step 3 — a missing X-CSRF-Token -> 403", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    const response = await fetchWorker(postPosts(authed, { csrfToken: null }));

    expect(response.status).toBe(403);
  });

  it("step 3 — a wrong X-CSRF-Token -> 403", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    const response = await fetchWorker(
      postPosts(authed, { csrfToken: "f".repeat(64) }),
    );

    expect(response.status).toBe(403);
  });

  it("step 4 precedes step 5 — a stale epoch on an UNVERIFIED user -> 401, not 403 EMAIL_NOT_VERIFIED", async () => {
    const userId = await insertUser(false);
    const authed = await authenticate(userId);

    await env.USER_SECURITY.getByName(userId).bumpEpoch();

    const response = await fetchWorker(postPosts(authed));

    expect(response.status).toBe(401);
  });

  it("step 5 — an unverified user with a fully valid request -> 403 EMAIL_NOT_VERIFIED", async () => {
    const userId = await insertUser(false);
    const authed = await authenticate(userId);

    const response = await fetchWorker(postPosts(authed));

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("EMAIL_NOT_VERIFIED");
  });

  /**
   * ⚠️ ASSERTED ON THE ROW, NOT THE RESPONSE. M0's stub echoed `authorId` in its
   * body, so this case simply read it back. The real handler does not echo it —
   * and it must not: the whole point is that author_id comes from the SESSION and
   * is never client-visible input. So the proof moves to the only place that can
   * still carry it, which is the row the handler actually wrote.
   */
  it("step 7 — the handler receives the VALIDATED session", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    const response = await fetchWorker(postPosts(authed));

    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    const ctx = createExecutionContext();
    const authorId = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ author_id: string }>(
        "SELECT author_id FROM posts WHERE id = $1",
        [id],
      );
      return rows[0]?.author_id ?? null;
    });
    await waitOnExecutionContext(ctx);

    expect(authorId).toBe(userId);
  });
});

describe("runMutatingPipeline opt-in steps", () => {
  /** A limiter that always reports the caller as over quota. */
  const exhaustedLimiter = {
    limit: async () => ({ success: false }),
  } as unknown as RateLimit;

  /** A limiter that always allows, recording the keys it was called with. */
  function allowingLimiter(): { limiter: RateLimit; keys: string[] } {
    const keys: string[] = [];
    return {
      keys,
      limiter: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: true };
        },
      } as unknown as RateLimit,
    };
  }

  it("step 6 — an opted-in sensitive route over quota -> 429", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);

    const ctx = createExecutionContext();
    const result = await runMutatingPipeline(postPosts(authed), env, ctx, {
      rateLimit: { limiter: exhaustedLimiter, key: `k_${userId}` },
    });
    await waitOnExecutionContext(ctx);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(429);
  });

  it("step 6 — the rate limit is keyed on what the route asked for, and passes the session through when allowed", async () => {
    const userId = await insertUser(true);
    const authed = await authenticate(userId);
    const { limiter, keys } = allowingLimiter();

    const ctx = createExecutionContext();
    const result = await runMutatingPipeline(postPosts(authed), env, ctx, {
      rateLimit: { limiter, key: `k_${userId}` },
    });
    await waitOnExecutionContext(ctx);

    expect(keys).toEqual([`k_${userId}`]);
    expect(result).not.toBeInstanceOf(Response);
    expect((result as { session: SessionData }).session.userId).toBe(userId);
  });

  it("steps 5 and 6 are OPT-IN: neither runs when the route does not ask (an UNVERIFIED user still passes)", async () => {
    // The same unverified user that `requireVerifiedEmail: true` rejects with a
    // 403 above must sail through a route that does not opt in — proving the
    // gate is a per-route choice and not baked into every mutation.
    const userId = await insertUser(false);
    const authed = await authenticate(userId);

    const ctx = createExecutionContext();
    const result = await runMutatingPipeline(postPosts(authed), env, ctx, {});
    await waitOnExecutionContext(ctx);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as { session: SessionData }).session.userId).toBe(userId);
  });
});
