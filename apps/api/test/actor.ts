import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import { csrfTokenFor } from "../src/auth/csrf";
import { createSession } from "../src/auth/session";
import { withClient } from "../src/db/client";

import type { SessionData } from "@thinkersjournal/shared";

/**
 * THE TEST ACTOR — a real user + profile + session, built DIRECTLY rather than
 * through `POST /auth/signup`.
 *
 * ⚠️ WHY NOT THE SIGNUP ROUTE (the reasoning is Task 8's, and it still holds):
 *   • signup issues a verification email through Postmark via global `fetch`.
 *     Only test/email-verify.test.ts stubs that; driving the real route here
 *     would put a live third-party HTTP call on every suite's setup path.
 *   • it would couple every case to FOUR unrelated routes (signup,
 *     __test/last-verify-token, verify-email, auth/csrf) and to SIGNUP_LIMITER.
 * The route under test is what is under test; the session is a fixture.
 *
 * ⚠️ EXTRACTED FROM test/media.test.ts IN TASK 9, and imported by it rather than
 * copied. Three suites (media, posts, public-reads) need the identical fixture,
 * and the epoch subtlety below is exactly the kind of detail that rots in a copy:
 * a made-up `securityEpoch` is a REVOKED session, so every case in a drifted
 * copy would 401 for a reason that has nothing to do with what it tests.
 */
export interface Actor {
  userId: string;
  /** The `profiles.username` — what the public read routes address them by. */
  username: string;
  cookie: string;
  csrfToken: string;
}

// `users.password_hash` is NOT NULL — a valid PHC-encoded argon2id string.
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZGlnZXN0";

/**
 * Every user id this module has created, for `deleteCreatedUsers`.
 *
 * ⚠️ MODULE STATE, AND THEREFORE PER-TEST-FILE. Vitest gives each test file its
 * own module registry, so each suite's `deleteCreatedUsers()` only ever deletes
 * the users IT created — which is the property wanted. Do not "share" this.
 */
const createdUserIds: string[] = [];

/**
 * INSERT a user (+ its profile) and return both ids.
 *
 * The email and username are per-call unique: THE TEST DATABASE PERSISTS across
 * runs (docker compose volume), so a fixed value would collide on `users.email`
 * / `profiles.username` on the second `vitest run` and every one after.
 */
async function insertUser(verified: boolean): Promise<{ userId: string; username: string }> {
  const ctx = createExecutionContext();
  const unique = crypto.randomUUID().replace(/-/g, "");
  const email = `actor_${unique}@example.com`;
  // Lowercase alnum only: `profiles.username` is what `/public/profile?username=`
  // addresses, and it lands in a URL query string.
  const username = `u${unique.slice(0, 20)}`;

  const userId = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END)
       RETURNING id`,
      [email, PASSWORD_HASH, verified],
    );
    const id = rows[0]!.id;
    await c.query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [id, username]);
    return id;
  });
  await waitOnExecutionContext(ctx);

  createdUserIds.push(userId);
  return { userId, username };
}

/**
 * A session for `userId`, plus the CSRF token a client must echo for it.
 *
 * ⚠️ `securityEpoch` is READ FROM THE USER'S DURABLE OBJECT, never hardcoded.
 * The pipeline compares this stamp against the DO on every mutation, so a
 * made-up epoch is a revoked session and every case using it would 401 before
 * reaching the thing it tests. This mirrors what `POST /auth/login` stamps.
 */
async function sessionFor(userId: string): Promise<{ cookie: string; csrfToken: string }> {
  const data: SessionData = {
    userId,
    roles: ["member"],
    securityEpoch: await env.USER_SECURITY.getByName(userId).getEpoch(),
    csrfSecret: "csrf-secret-value",
    createdAt: Date.now(),
  };
  const { cookie } = await createSession(env, data);
  return { cookie: cookie.split(";")[0]!, csrfToken: await csrfTokenFor(data) };
}

/** A VERIFIED actor — one that passes the soft gate and may mutate content. */
export async function createVerifiedActor(): Promise<Actor> {
  const { userId, username } = await insertUser(true);
  return { userId, username, ...(await sessionFor(userId)) };
}

/**
 * An UNVERIFIED actor (`email_verified_at IS NULL`) — everything a verified one
 * has EXCEPT the soft gate's permission. Its session is real and unrevoked, so a
 * 403 from a content route is the GATE, not a broken fixture.
 */
export async function createUnverifiedActor(): Promise<Actor> {
  const { userId, username } = await insertUser(false);
  return { userId, username, ...(await sessionFor(userId)) };
}

/**
 * Delete every user this module created. FK cascades clear `profiles`, `posts`
 * and `media`, so this is the whole cleanup.
 */
export async function deleteCreatedUsers(): Promise<void> {
  if (createdUserIds.length === 0) return;
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUserIds]),
  );
  await waitOnExecutionContext(ctx);
  createdUserIds.length = 0;
}
