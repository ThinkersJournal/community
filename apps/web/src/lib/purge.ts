/**
 * THE PURGE HOP'S DECISION LOGIC — who may invalidate our cached renders, and
 * with which tags. `src/pages/internal/purge.ts` is the route; this is what it
 * decides.
 *
 * ⚠️ WHY THIS RUNS ON `web` AND NOT ON `api`. Workers Cache purge is scoped to the
 * Worker that OWNS the cache: `api` cannot reach into this Worker's cache, no
 * matter what it calls. So `api` (which knows an edit happened) asks THIS Worker
 * (which owns the cache) to purge — see apps/api/src/cache/purge.ts. The scope
 * that matters is the WORKER, not the file: this module is bundled into `web`, so
 * `context.cache.invalidate()` here runs inside web's entrypoint, which is the
 * only place it means anything.
 *
 * ⚠️ THE ROUTE IS PUBLICLY REACHABLE, AND THE SECRET IS ITS ONLY GUARD.
 * `web` is the public Worker: https://community.thinkersjournal.com/internal/purge is a
 * real, routable URL. There is NO way to prove a request arrived over the Service
 * Binding — no header a caller cannot forge, no address to check. So the shared
 * secret IS the authorization, it is compared in constant time, and it must be a
 * real high-entropy value set as a secret on BOTH Workers (README's deploy gate).
 * Do not add a "came from the binding" check that only looks like one.
 *
 * ⚠️ WORST CASE IF THE SECRET LEAKS: an attacker can purge our cache, i.e. force
 * re-renders. That is a cost/DoS lever, not a data leak — this route reads
 * nothing and writes nothing. Rotate the secret; do not panic.
 *
 * ⚠️ SPLIT FROM THE ROUTE SO IT CAN BE TESTED AT ALL. The route must read
 * `env.PURGE_SECRET` from `cloudflare:workers`, which does not resolve outside
 * workerd — and apps/web's vitest is plain Node (see vitest.config.ts). Taking the
 * secret as an ARGUMENT keeps every refusal path under test (test/purge.test.ts)
 * instead of provable only by deploying. Same shape as src/lib/cache.ts: the
 * decisions live in a module with a structural context; the page is glue.
 */
import { logSecurityEvent, timingSafeEqual } from "@thinkersjournal/shared";

/**
 * The subset of Astro's `APIContext` this needs. Structural rather than importing
 * Astro's type, so the tests can build one without a renderer — and so this module
 * states exactly what it touches.
 *
 * Verified assignable from the real `APIContext` (astro@7.0.9): `cache` is
 * `CacheLike`, whose `invalidate` accepts `InvalidateOptions | LiveDataEntry`,
 * and `InvalidateOptions = { path?: string; tags?: string | string[] }` — a
 * strict superset of the `{ tags: string[] }` passed below.
 */
export interface PurgeContext {
  request: Request;
  cache: { invalidate: (input: { tags: string[] }) => Promise<void> };
}

/** The header `api` sends the shared secret in (apps/api/src/cache/purge.ts). */
const SECRET_HEADER = "X-Purge-Secret";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Whether `submitted` authorizes this request against the binding's `secret`.
 *
 * ⚠️ FAILS CLOSED ON A MISSING HEADER *AND* ON A MISSING/EMPTY SECRET. The empty
 * case is the one worth stating: `timingSafeEqual("", "")` is TRUE, so without the
 * explicit guard an unset or blank `PURGE_SECRET` would authorize the entire
 * internet — and `web` is public. That is not hypothetical; it is exactly what a
 * `wrangler secret put` run on `api` but not on `web` would produce.
 *
 * ⚠️ LENGTH-SAFE, AND THE `await` IS LOAD-BEARING. `timingSafeEqual` hashes both
 * sides before comparing (packages/shared/src/timing-safe.ts), so a wrong guess of
 * any length takes the same path and the secret's length does not leak by timing.
 * That makes it async: without the `await` it returns a Promise, which is TRUTHY,
 * and this function would authorize every caller on the internet. Observed: the
 * moment the shared compare went async, every refusal test in test/purge.test.ts
 * answered 200 until this line awaited it.
 */
async function authorized(submitted: string | null, secret: string | undefined): Promise<boolean> {
  if (submitted === null || secret === undefined || secret === "") return false;
  return await timingSafeEqual(submitted, secret);
}

/**
 * The slice of Cloudflare's rate-limit binding (`PURGE_LIMITER`, apps/web/
 * wrangler.jsonc) this needs. Structural for the same reason as `PurgeContext`:
 * this suite runs in plain Node, with a fake.
 */
export interface PurgeFailureLimiter {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

/** This route, as its `security:` log lines name it. */
const ROUTE = "/internal/purge";

/**
 * Handle a purge request: authorize it, read its tags, invalidate them.
 *
 * `secret` is the value of the `PURGE_SECRET` binding — `undefined` when it is
 * not set, which must refuse everything (see `authorized`).
 *
 * ⚠️ DOES NOT CATCH `invalidate` FAILURES, deliberately. If the purge throws, this
 * route 500s and `api` logs a rejected purge — which is TRUE. Answering
 * `{ purged: n }` for a purge that did not happen would turn a loud, fixable
 * failure into content silently stale for 25h. The caller is the one that must not
 * throw (apps/api/src/cache/purge.ts), and it doesn't: a failure here costs a log
 * line, not the user's edit.
 *
 * ⚠️ ONLY FAILED ATTEMPTS ARE RATE-LIMITED (brute-force audit 2026-10-06, #23).
 * `failureLimiter` is consumed AFTER the secret check, and only when it fails,
 * keyed `purge-fail:<CF-Connecting-IP>`. The order is the point:
 *   - The api's legitimate purges arrive over the Service Binding with only
 *     `content-type` and `X-Purge-Secret` (apps/api/src/cache/purge.ts). Whether
 *     or not the platform attaches a `CF-Connecting-IP` to that hop, an
 *     AUTHORIZED request never reaches the limiter, so it can never be throttled
 *     — not by its own volume, and not by an attacker spending a shared bucket.
 *   - A failure with no `CF-Connecting-IP` did not come through Cloudflare's
 *     public edge, which always sets it. It is refused and logged but not
 *     limited: one shared "unknown" bucket would be spendable by anyone.
 *   - What this does NOT do: slow down a guesser who eventually guesses RIGHT.
 *     A correct secret is authorized even from an IP over its failure limit,
 *     because the limiter cannot be read without being spent. So the limiter
 *     bounds the noise and makes the attempts visible (one `security:` line each);
 *     the defense against guessing is the secret's entropy (README deploy gate:
 *     a high-entropy value on both Workers).
 */
export async function handlePurgeRequest(
  context: PurgeContext,
  secret: string | undefined,
  failureLimiter: PurgeFailureLimiter,
): Promise<Response> {
  if (!(await authorized(context.request.headers.get(SECRET_HEADER), secret))) {
    const ip = context.request.headers.get("CF-Connecting-IP");
    // The submitted value is NEVER logged — only that it failed, and from where.
    logSecurityEvent({ kind: "auth_failure", route: ROUTE, reason: "bad_purge_secret", ip });
    if (ip !== null) {
      const { success } = await failureLimiter.limit({ key: `purge-fail:${ip}` });
      if (!success) {
        logSecurityEvent({ kind: "rate_limited", route: ROUTE, reason: "ip", ip });
        return json({ code: "RATE_LIMITED" }, 429);
      }
    }
    // No detail: a caller that cannot authorize learns only that it cannot.
    return json({ code: "FORBIDDEN" }, 403);
  }

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return json({ code: "INVALID_JSON" }, 400);
  }

  const raw = (body as { tags?: unknown } | null)?.tags;
  const tags = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string" && t !== "") : [];
  // An empty list is a BUG IN THE CALLER, not a no-op to absorb quietly: api
  // already returns early on an empty tag list, so reaching here with none means
  // the two halves disagree. Say so rather than spending a request on nothing.
  if (tags.length === 0) return json({ code: "INVALID_INPUT", fields: ["tags"] }, 400);

  // ⚠️ INSIDE THIS WORKER'S ENTRYPOINT — the only scope where this call reaches
  // the cache holding our rendered HTML. One call, every tag: the Free-zone purge
  // limit is 5 requests/minute (100 operations per request).
  //
  // ⚠️ WHAT THIS ACTUALLY CALLS (verified against the INSTALLED packages, not a
  // blog post — @astrojs/cloudflare@14.1.3, dist/cache/provider.js):
  //     invalidate(options) -> const { cache } = await import("cloudflare:workers")
  //                         -> cache.purge({ tags })
  // i.e. the `cache` MODULE EXPORT of `cloudflare:workers`. There is no
  // `ctx.cache.purge()` — the research note's shorthand for that is not an API.
  //
  // ⚠️ THIS THROWS UNDER LOCAL `wrangler dev`, AND THAT IS EXPECTED — DO NOT
  // "FIX" IT BY SWALLOWING IT. Workers Cache is not simulated locally: the
  // `cache` module export exists but has no `purge`, so this line dies with
  //     TypeError: cache.purge is not a function
  // and the route 500s. Observed against a built Worker on workerd@1.20260708.1.
  // Everything BEFORE this line is genuinely exercised locally (routing, the
  // secret check, the tags, the adapter's provider) — only the final primitive is
  // absent. The api ABSORBS the 500 (it logs and never throws), so a local
  // publish/edit still succeeds; it just logs `cache purge rejected`. Making this
  // return 200 anyway would fake a purge that did not happen and would hide a
  // REAL outage in production behind the same silence.
  //
  // ⚠️ It ALSO throws if the cache provider is ever removed from astro.config.mjs:
  // astro's AstroCache.invalidate() throws `CacheNotEnabled` when no provider is
  // configured, and DisabledAstroCache.invalidate() always throws (verified in
  // astro@7.0.9 dist/core/cache/runtime/{cache,noop}.js). Same handling: loud.
  await context.cache.invalidate({ tags });

  return json({ purged: tags.length }, 200);
}
