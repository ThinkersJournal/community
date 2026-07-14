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
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The subset of Cloudflare's `siteverify` response this module relies on. */
interface SiteverifyResponse {
  success: boolean;
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
 * verification (reject the signup) rather than silently proceeding.
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
  return data.success === true;
}
