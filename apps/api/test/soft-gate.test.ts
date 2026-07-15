import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import worker from "../src";
import { csrfTokenFor } from "../src/auth/csrf";
import { createSession } from "../src/auth/session";
import { withClient } from "../src/db/client";

import type { SessionData } from "@thinkersjournal/shared";

/**
 * Task 13 — the SOFT email-verification gate: unverified users may
 * READ/browse freely, but CONTENT MUTATION (here, `POST /posts`) requires a
 * verified email. `GET /posts` proves reads stay open regardless.
 *
 * Runs in the POOL project (real workerd) — needs the `SESSIONS` KV binding
 * (for `createSession`/`readSession`), `HYPERDRIVE_FRESH` (for the `users`
 * row) and, since Task 16, the `USER_SECURITY` Durable Object, plus the
 * Worker's `fetch` handler.
 *
 * ⚠️ TASK 16 UPDATE — these requests now carry an allowed `Origin`, a correct
 * `X-CSRF-Token`, and a session stamped with the user's REAL security epoch.
 * `POST /posts` runs the full mutating pipeline (src/auth/pipeline.ts), which
 * rejects a request missing any of those BEFORE the email gate is ever
 * consulted; without them these cases would still go red/green on the right
 * status codes but for entirely the wrong reason, and would stop testing the
 * gate at all. The gate's own properties below are UNCHANGED — every
 * assertion is exactly the one Task 13 pinned.
 */

/** An origin in `checkOrigin`'s allowlist (src/auth/csrf.ts). */
const ALLOWED_ORIGIN = "http://localhost:8787";

// `users.password_hash` is NOT NULL — a valid PHC-encoded argon2id string.
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZGlnZXN0";

/** Rows created by a test, deleted in `afterEach`. */
const createdUserIds: string[] = [];

/** INSERT an UNVERIFIED user (`email_verified_at IS NULL`) with a per-run-unique email; returns its id. */
async function insertUnverifiedUser(): Promise<string> {
  const ctx = createExecutionContext();
  const email = `t13_${crypto.randomUUID()}@example.com`;
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, PASSWORD_HASH],
    );
    return rows[0].id as string;
  });
  await waitOnExecutionContext(ctx);
  createdUserIds.push(id);
  return id;
}

/** Stamp `email_verified_at = now()` for `userId` via the FRESH binding. */
async function verifyUser(userId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [
      userId,
    ]),
  );
  await waitOnExecutionContext(ctx);
}

interface Authed {
  /** The raw `tj_session` cookie token. */
  token: string;
  /** The value the client must echo in `X-CSRF-Token` for this session. */
  csrfToken: string;
}

/**
 * Create a real session for `userId`, returning its cookie token and matching
 * CSRF token.
 *
 * ⚠️ `securityEpoch` is read from the user's Durable Object rather than
 * hardcoded (Task 13 stamped a literal `1`, which no fresh user has — a fresh
 * DO starts at 0). Since Task 16 the pipeline compares this stamp against the
 * DO on every mutation, so a made-up epoch is a REVOKED session: every case
 * below would 401 before reaching the gate. This mirrors what `POST
 * /auth/login` stamps (src/routes/login.ts, step 7).
 */
async function sessionTokenFor(userId: string): Promise<Authed> {
  const data: SessionData = {
    userId,
    roles: ["member"],
    securityEpoch: await env.USER_SECURITY.getByName(userId).getEpoch(),
    csrfSecret: "csrf-secret-value",
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
 * A request carrying `authed`'s session. Non-GET requests also carry the
 * allowed `Origin` and the `X-CSRF-Token` the pipeline requires — a real
 * browser client sends both, and without them the pipeline rejects the request
 * before the email gate under test runs at all.
 */
function requestWithCookie(
  path: string,
  method: string,
  authed: Authed,
): Request {
  const headers = new Headers({ Cookie: `tj_session=${authed.token}` });
  if (method !== "GET" && method !== "HEAD") {
    headers.set("Origin", ALLOWED_ORIGIN);
    headers.set("X-CSRF-Token", authed.csrfToken);
  }
  return new Request(`https://api.test${path}`, { method, headers });
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

describe("soft email-verification gate", () => {
  it("POST /posts with an unverified session -> 403 EMAIL_NOT_VERIFIED", async () => {
    const userId = await insertUnverifiedUser();
    const authed = await sessionTokenFor(userId);

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      requestWithCookie("/posts", "POST", authed),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain(
      "application/json",
    );
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("POST /posts succeeds once the user's email is verified", async () => {
    const userId = await insertUnverifiedUser();
    const authed = await sessionTokenFor(userId);
    await verifyUser(userId);

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      requestWithCookie("/posts", "POST", authed),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // ⚠️ The EXACT success status, not `not.toBe(403)`. This case is the gate's
    // positive half — it must prove the request reached the handler, and only a
    // 201 does. `not.toBe(403)` was satisfied by a 401 (a broken session or a
    // stale epoch) and by a 500 (the DB read throwing) just as happily as by
    // success, so the assertion would have stayed green while the thing it
    // claims to test had stopped happening entirely.
    expect(response.status).toBe(201);
    // The handler's own stub body — proof this is `handleCreatePost`'s response
    // and that the pipeline handed it the right validated session.
    const body = (await response.json()) as { ok: boolean; authorId: string };
    expect(body).toEqual({ ok: true, authorId: userId });
  });

  /**
   * FAIL-CLOSED on a missing user row: a session that is entirely valid —
   * well-formed, unrevoked (its epoch matches the DO's, which answers for any
   * name whether or not a `users` row exists), CSRF-correct — but whose user has
   * no row in Postgres.
   *
   * Reachable in practice: the account was deleted while a session was live.
   * `requireVerifiedEmail` reads `rows[0]?.email_verified_at ?? null`, and the
   * `?? null` is what turns "no row" into DENY rather than a crash — the row's
   * ABSENCE and an unverified row take the identical path. This pins that the
   * unknown user is refused (403), never let through, and never 500s: the
   * dangerous refactor is `rows[0].email_verified_at`, which throws on undefined
   * and would turn a deleted account into a 500 on every mutation.
   */
  it("POST /posts with a valid session whose user row is gone -> 403", async () => {
    // Never inserted, so no `users` row exists for it — and deliberately NOT
    // pushed to `createdUserIds`, since there is nothing to clean up.
    const ghostUserId = crypto.randomUUID();
    const authed = await sessionTokenFor(ghostUserId);

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      requestWithCookie("/posts", "POST", authed),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("GET /posts with the SAME unverified session -> 200 (reads are open)", async () => {
    const userId = await insertUnverifiedUser();
    const authed = await sessionTokenFor(userId);

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      requestWithCookie("/posts", "GET", authed),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
  });

  it("POST /posts with no session -> 401 (not 403)", async () => {
    const ctx = createExecutionContext();
    // Carries the allowed `Origin` so the pipeline's origin check passes and
    // the MISSING SESSION is what this case actually exercises — the point
    // being that it 401s rather than 403ing like the unverified case above.
    const response = await worker.fetch(
      new Request("https://api.test/posts", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });
});
