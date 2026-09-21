import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { sha256Hex } from "../src/auth/encoding";
import { verifyPassword } from "../src/auth/password";
import { createResetToken } from "../src/auth/password-reset";
import { withClient } from "../src/db/client";
import { createUnverifiedActor, createVerifiedActor, deleteCreatedUsers } from "./actor";

/**
 * #70 — `POST /auth/reset-password`. Runs in the POOL project (real
 * workerd): needs `HYPERDRIVE_FRESH` and `USER_SECURITY` (DO). The full
 * request->mail->redeem round trip through `POST /auth/forgot-password` is
 * pinned in test/forgot-password.test.ts; this file owns the redemption
 * step's own behaviour in isolation, minting tokens directly via
 * `createResetToken` (the same primitive `forgot-password.ts` calls) — same
 * split as test/resend-verification.test.ts vs test/signup.test.ts.
 */

const ALLOWED_ORIGIN = "http://localhost:8787";
const NEW_PASSWORD = "a-brand-new-password-123";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function resetPasswordRequest(
  body: unknown,
  headers: Record<string, string> = { Origin: ALLOWED_ORIGIN },
): Request {
  return new Request("https://api.test/auth/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function resetPassword(
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetchWorker(resetPasswordRequest(body, headers));
}

async function mintToken(userId: string): Promise<string> {
  const ctx = createExecutionContext();
  const token = await createResetToken(env, ctx, userId);
  await waitOnExecutionContext(ctx);
  return token;
}

/** Read a user's current password_hash / email_verified_at directly. */
async function userRow(
  userId: string,
): Promise<{ password_hash: string; email_verified_at: Date | null }> {
  const ctx = createExecutionContext();
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ password_hash: string; email_verified_at: Date | null }>(
      "SELECT password_hash, email_verified_at FROM users WHERE id = $1",
      [userId],
    );
    return rows[0]!;
  });
  await waitOnExecutionContext(ctx);
  return row;
}

/** Force a token's expires_at into the past — for the expired-token case. */
async function expireToken(token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE password_reset_tokens SET expires_at = now() - interval '1 hour' WHERE token_hash = $1", [
      tokenHash,
    ]),
  );
  await waitOnExecutionContext(ctx);
}

/** `GET /auth/csrf` with `cookie` — 200 if the session is live, 401 if revoked/unknown. */
async function sessionIsLive(cookie: string): Promise<boolean> {
  const response = await fetchWorker(
    new Request("https://api.test/auth/csrf", { headers: { Cookie: cookie } }),
  );
  return response.status === 200;
}

afterEach(async () => {
  await deleteCreatedUsers();
});

describe("POST /auth/reset-password", () => {
  it("200s, writes the new password (old password no longer verifies), and Sets-Cookie", async () => {
    const actor = await createVerifiedActor();
    const token = await mintToken(actor.userId);

    const response = await resetPassword({ token, password: NEW_PASSWORD });
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).not.toBeNull();

    // The password actually changed — verified independently of the route,
    // via Argon2id, not merely "some value got written".
    const row = await userRow(actor.userId);
    expect(await verifyPassword(NEW_PASSWORD, row.password_hash)).toBe(true);
  });

  /**
   * ⚠️ THE REVOCATION PROPERTY — logout-all's exact mechanism, reused. A
   * session that existed BEFORE the reset must be dead AFTER it, or a
   * stolen-but-still-valid cookie survives its own victim's recovery.
   */
  it("invalidates every session that existed before the reset", async () => {
    const actor = await createVerifiedActor();
    expect(await sessionIsLive(actor.cookie)).toBe(true);

    const token = await mintToken(actor.userId);
    expect((await resetPassword({ token, password: NEW_PASSWORD })).status).toBe(200);

    expect(await sessionIsLive(actor.cookie)).toBe(false);
  });

  /** The NEW session the response itself mints must be live. */
  it("the new session in the response's Set-Cookie is immediately usable", async () => {
    const actor = await createVerifiedActor();
    const token = await mintToken(actor.userId);

    const response = await resetPassword({ token, password: NEW_PASSWORD });
    const newCookie = response.headers.get("Set-Cookie")!.split(";")[0]!;

    expect(await sessionIsLive(newCookie)).toBe(true);
  });

  /**
   * Ruling 1 (PM, re-derived): redeeming proves the same fact verify-email
   * exists to prove, via an equally strong token — so a reset by an
   * unverified account marks it verified.
   */
  it("marks an unverified account's email verified on success", async () => {
    const actor = await createUnverifiedActor();
    expect((await userRow(actor.userId)).email_verified_at).toBeNull();

    const token = await mintToken(actor.userId);
    expect((await resetPassword({ token, password: NEW_PASSWORD })).status).toBe(200);

    expect((await userRow(actor.userId)).email_verified_at).not.toBeNull();
  });

  /** COALESCE — never rewrite an EARLIER verification timestamp. */
  it("does not clobber an already-verified email_verified_at", async () => {
    const actor = await createVerifiedActor();
    const before = (await userRow(actor.userId)).email_verified_at;

    const token = await mintToken(actor.userId);
    expect((await resetPassword({ token, password: NEW_PASSWORD })).status).toBe(200);

    expect((await userRow(actor.userId)).email_verified_at).toEqual(before);
  });

  it("400s INVALID_RESET_TOKEN for an unknown token", async () => {
    const response = await resetPassword({ token: "not-a-real-token", password: NEW_PASSWORD });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_RESET_TOKEN");
  });

  it("400s INVALID_RESET_TOKEN for an EXPIRED token", async () => {
    const actor = await createVerifiedActor();
    const token = await mintToken(actor.userId);
    await expireToken(token);

    const response = await resetPassword({ token, password: NEW_PASSWORD });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_RESET_TOKEN");
  });

  /**
   * ⚠️ SINGLE-USE, PROVEN BY A REAL DOUBLE-REDEEM — not merely asserted. The
   * atomic `UPDATE ... WHERE used_at IS NULL` is the whole point of the
   * dedicated table over KV's non-atomic peek/delete pair (see
   * src/auth/password-reset.ts's header); this is what proves it holds.
   */
  it("a token cannot be redeemed twice", async () => {
    const actor = await createVerifiedActor();
    const token = await mintToken(actor.userId);

    expect((await resetPassword({ token, password: NEW_PASSWORD })).status).toBe(200);

    const second = await resetPassword({ token, password: "yet-another-password-456" });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { code: string }).code).toBe("INVALID_RESET_TOKEN");

    // And the FIRST password write is what stuck — the second attempt truly
    // changed nothing.
    const row = await userRow(actor.userId);
    expect(await verifyPassword(NEW_PASSWORD, row.password_hash)).toBe(true);
  });

  it("400s invalid input (password under the 12-char floor)", async () => {
    const response = await resetPassword({ token: "whatever", password: "short" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it("400s malformed JSON", async () => {
    const response = await fetchWorker(
      new Request("https://api.test/auth/reset-password", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_JSON");
  });

  it("403s without an allowed Origin — before any parsing/DB work, even with a real token", async () => {
    const actor = await createVerifiedActor();
    const token = await mintToken(actor.userId);

    const response = await resetPassword({ token, password: NEW_PASSWORD }, {});
    expect(response.status).toBe(403);

    // The token must still be UNREDEEMED — the origin rejection happened
    // before the token was ever looked up.
    expect((await resetPassword({ token, password: NEW_PASSWORD })).status).toBe(200);
  });
});
