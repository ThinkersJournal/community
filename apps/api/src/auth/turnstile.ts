/**
 * Cloudflare Turnstile server-side verification for the `api` Worker's signup
 * flow (bot defense). The client solves a Turnstile challenge and hands us its
 * response token; this module confirms that token with Cloudflare before the
 * signup is allowed to proceed.
 *
 * Turnstile response tokens are single-use and expire ~300s after issuance —
 * `siteverify` itself invalidates a token the moment it verifies it. That
 * makes the result of this call inherently non-reusable, so it is NEVER
 * cached, and there is no retry/backoff logic (YAGNI): a transient failure
 * just resolves `false`, and the caller re-prompts the user for a fresh
 * challenge rather than we retrying with an already-consumed token.
 *
 * ⚠️ LOGS `error-codes` ON FAILURE (2026-09-24) — added when signup AND
 * password reset both broke in production with no way to tell why.
 * `signup.ts`'s shared 403 deliberately answers a failed Turnstile and a
 * rejected Origin identically ("keeps the two defenses from being probed
 * apart" — a real security property, not an oversight), which means the
 * CLIENT RESPONSE can never say which one fired. `siteverify`'s `success:
 * false` is itself equally uninformative — `missing-input-secret`,
 * `invalid-input-secret`, `invalid-input-response`, `timeout-or-duplicate`,
 * and a hostname mismatch are five different faults that all look
 * identical from outside. `error-codes` is the one field that names the
 * actual cause, and until now this module discarded it. It goes to the
 * SERVER log only — see the function's own header for exactly what may and
 * may not appear there.
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The subset of Cloudflare's `siteverify` response this module relies on. */
interface SiteverifyResponse {
  success: boolean;
  /**
   * Present on failure (and sometimes alongside success, e.g. a duplicate
   * warning) — Cloudflare's own diagnostic codes for WHY `success` is what
   * it is. See https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
   * for the vocabulary (`missing-input-secret`, `invalid-input-secret`,
   * `missing-input-response`, `invalid-input-response`,
   * `bad-request`, `timeout-or-duplicate`, `internal-error`).
   */
  "error-codes"?: string[];
}

/**
 * Verify a Turnstile response `token` against Cloudflare's `siteverify`
 * endpoint, using the Worker's `TURNSTILE_SECRET_KEY` secret. `remoteip`
 * (the visitor's IP, when available) is forwarded as an extra signal, per
 * Cloudflare's documented `siteverify` request shape.
 *
 * Resolves `true` only when the response's `success` field is exactly
 * `true`; any other outcome (`success: false`, a malformed/unexpected body)
 * resolves `false`. A network-level failure or non-JSON response propagates
 * as a rejected promise — callers should treat that the same as a failed
 * verification (reject the signup) rather than silently proceeding. ⚠️ THIS
 * CONTRACT IS UNCHANGED by the logging added below — a throw is still a
 * throw, a `false` is still just `false`; logging never turns one into the
 * other, and never turns a `false` into a silent pass.
 *
 * ⚠️ ON A FAILURE (`success !== true`), logs ONLY `error-codes` — never the
 * secret (`env.TURNSTILE_SECRET_KEY`) and never the response `token`. Both
 * are credentials; `error-codes` is Cloudflare's own diagnostic vocabulary,
 * never a value an attacker supplied. This does NOT change the HTTP
 * response the caller sends back to the browser in any way — the reason
 * lives in the server log, where only an operator with `wrangler tail` (or
 * dashboard log) access can see it, which is deliberate: splitting the
 * shared 403 or exposing this in a header/response body would let an
 * attacker probe Turnstile and Origin rejection apart from outside, which
 * is exactly what the shared 403 exists to prevent.
 */
export async function verifyTurnstile(
  env: Env,
  token: string,
  remoteip?: string,
): Promise<boolean> {
  const res = await fetch(SITEVERIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
      ...(remoteip ? { remoteip } : {}),
    }),
  });

  const data = (await res.json()) as SiteverifyResponse;
  const ok = data.success === true;
  if (!ok) {
    // ⚠️ error-codes ONLY — see this function's header for what must never
    // appear alongside it.
    console.error("turnstile siteverify failed", { errorCodes: data["error-codes"] ?? [] });
  }
  return ok;
}
