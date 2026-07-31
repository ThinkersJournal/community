/**
 * One-click unsubscribe (M2.3c, RFC 8058). Token-authed, NO session / CSRF /
 * Origin check: the POST comes cross-origin from a mail provider with no cookie,
 * and the HMAC token IS the auth. The only effect is master_enabled=false for the
 * token's user. ALWAYS returns a neutral 200 — never reveal whether a token was
 * valid, never error. Idempotent. Listed in PIPELINE_EXEMPT and allowlisted in
 * error-envelope.test.ts (it has no error path).
 *
 * ⚠️ THE DB WRITE IS TRY/CAUGHT AND ITS ERROR SWALLOWED, ON PURPOSE. "Always a
 * neutral 200" is a HARD constraint, and the write CAN fail deterministically:
 * unsub tokens never expire, so a VALID token minted for an account that was
 * later deleted hits a foreign-key violation on the INSERT
 * (notification_prefs.user_id REFERENCES users(id)). Letting that throw would
 * escape `fetch` as a raw 500 — the dispatcher has no catch by design (adding one
 * would change the error-envelope contract for every route). So the failure is
 * contained HERE: log it (never the token) and return the SAME neutral `ok()` an
 * invalid token gets, so a valid-but-user-gone token and any transient DB blip
 * are indistinguishable from success.
 */
import { withClient } from "../db/client";
import { verifyUnsubToken } from "../notifications/unsub-token";

export async function handleUnsub(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  const ok = (): Response =>
    new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  const userId = token === null ? null : await verifyUnsubToken(env, token);
  if (userId === null) return ok(); // neutral

  try {
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query(
        `INSERT INTO notification_prefs (user_id, master_enabled, updated_at)
         VALUES ($1, false, now())
         ON CONFLICT (user_id) DO UPDATE SET master_enabled = false, updated_at = now()`,
        [userId],
      ),
    );
  } catch (err) {
    // Never logs the token. A valid token for a since-deleted user (FK
    // violation) or any transient DB failure must still answer neutrally.
    console.error("unsub write failed", err);
  }
  return ok();
}
