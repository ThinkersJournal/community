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
 *
 * ⚠️ BE HONEST ABOUT WHAT "OWNS ALL COUNTING/WINDOW LOGIC" BUYS YOU. The
 * binding is NOT an exact counter, and callers must not reason about it as one.
 * Cloudflare documents it as enforcing a unique limit per key **PER CLOUDFLARE
 * LOCATION**, and as "permissive, eventually consistent, and intentionally
 * designed to not be used as an accurate accounting system". Two consequences
 * that matter for the auth routes:
 *
 *   • A "10 per 60s" limit is 10 per 60s PER LOCATION, not globally. A
 *     geographically distributed attacker gets roughly (limit × locations)
 *     attempts per window, and no key design here can change that.
 *   • Counts are eventually consistent, so a burst can briefly overshoot the
 *     threshold before the limiter catches up.
 *
 * So a limiter key is a CEILING-SHAPING tool, not a hard guarantee: it is what
 * turns an unbounded attack into a bounded-and-expensive one. The routes lean on
 * it accordingly — see the two-bucket keying in src/routes/login.ts, which
 * exists precisely because the per-IP key had no ceiling at all against a
 * multi-IP attacker. Anything needing exact accounting wants a Durable Object
 * (src/durable-objects/UserSecurityDO.ts), not this binding.
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
