/**
 * The soft email-verification gate (M0, Task 13).
 *
 * Policy: unverified users may READ/browse freely, but CONTENT MUTATION
 * (posting/commenting/following) requires a verified email. This file holds
 * ONLY that one gate for now — Task 16 EXTENDS it into the full mutating
 * pipeline (origin -> session -> CSRF -> epoch -> verified-email ->
 * rate-limit -> handler) shared across every content-mutation route.
 * `requireVerifiedEmail` is written as a `Response | null` step so that
 * pipeline can drop it straight in alongside `enforceRateLimit` (see
 * src/auth/ratelimit.ts) and `checkCsrf`/`checkOrigin` (see src/auth/csrf.ts).
 *
 * Deliberately NOT applied to auth routes (signup/login/logout — an
 * unverified user must still be able to log in and log out) and NOT to GETs;
 * callers opt a route in explicitly (see src/routes/posts.ts).
 */
import { withClient } from "../db/client";

import type { SessionData } from "@thinkersjournal/shared";

/**
 * The exact 403 response for an unverified session. The `code` value is
 * load-bearing — the web app keys off this exact string to show its
 * "verify your email" prompt, so it must not be renamed or reworded.
 */
function emailNotVerifiedResponse(): Response {
  return new Response(JSON.stringify({ code: "EMAIL_NOT_VERIFIED" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Gate for content-mutation routes. Resolves `null` ("allowed, proceed")
 * when `session`'s user has a verified email (`users.email_verified_at IS
 * NOT NULL`), or the 403 `Response` above otherwise — including when the
 * user row is somehow missing, which fails closed rather than throwing.
 *
 * Signature note: the task brief describes this as `(env, session)`, but the
 * DB read requires an `ExecutionContext` to satisfy `withClient`'s 3-arg
 * signature (`ctx.waitUntil(client.end())` — the same reconciliation Task 6
 * made for every other DB-touching helper in this Worker). `ctx` is threaded
 * as the second parameter here.
 *
 * Reads via `HYPERDRIVE_FRESH` (cache-disabled) — NEVER `HYPERDRIVE_CACHED`.
 * Hyperdrive never invalidates on write, so a cached read here would keep
 * denying (or granting) access based on a stale `email_verified_at` for up
 * to 60s after `GET /verify-email` runs — a real security bug.
 */
export async function requireVerifiedEmail(
  env: Env,
  ctx: ExecutionContext,
  session: SessionData,
): Promise<Response | null> {
  const verifiedAt = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ email_verified_at: Date | null }>(
      "SELECT email_verified_at FROM users WHERE id = $1",
      [session.userId],
    );
    return rows[0]?.email_verified_at ?? null;
  });

  return verifiedAt === null ? emailNotVerifiedResponse() : null;
}
