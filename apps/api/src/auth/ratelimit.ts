/**
 * Brute-force defense for the `api` Worker's signup/login flows, backed by
 * Cloudflare's rate-limiting bindings (`SIGNUP_LIMITER` / `LOGIN_LIMITER`, each
 * a `simple` fixed-window limiter).
 *
 * ⚠️ THE WRANGLER CONFIG KEY IS THE PLURAL `ratelimits`, and the distinction is
 * load-bearing — the singular `ratelimit` is NOT a valid top-level key and does
 * not declare anything. It is spelled `ratelimits` in `wrangler.jsonc`, whose
 * own note records the verification against wrangler 4.110.0's config schema;
 * that file, not this sentence, is the source of truth. Mentally search for the
 * plural when tracing where `SIGNUP_LIMITER` comes from.
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
