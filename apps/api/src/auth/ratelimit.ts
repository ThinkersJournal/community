/**
 * Brute-force defense for the `api` Worker's signup/login flows, backed by
 * Cloudflare's `ratelimit` binding (see `SIGNUP_LIMITER` / `LOGIN_LIMITER` in
 * `wrangler.jsonc`, each a `simple` fixed-window limiter).
 *
 * Deliberately minimal (YAGNI): the binding itself owns all counting/window
 * logic, so this helper is just the request-shaped translation of its result
 * — `null` means "allowed, proceed", a 429 `Response` means "blocked, return
 * this directly to the client". No retry/backoff/custom messaging.
 */

/**
 * Consume one unit of `limiter`'s quota for `key`. Resolves `null` when the
 * request is allowed to proceed, or a `429 Too Many Requests` `Response` when
 * the caller should return that response immediately instead of continuing.
 */
export async function enforceRateLimit(
  limiter: RateLimit,
  key: string,
): Promise<Response | null> {
  const { success } = await limiter.limit({ key });
  return success ? null : new Response("Too many requests", { status: 429 });
}
