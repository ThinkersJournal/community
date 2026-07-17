/**
 * THE CROSS-WORKER PURGE HOP.
 *
 * ⚠️ THIS WORKER CANNOT PURGE `web`'s CACHE. Workers Cache purge is scoped to the
 * Worker+entrypoint that OWNS the cache — "a Worker cannot reach into another
 * Worker's cache." Edits land here; the rendered HTML lives in `web`'s cache. So
 * we ASK `web`, over the `WEB` Service Binding, and `web` calls
 * context.cache.invalidate() inside its own entrypoint (apps/web/src/lib/purge.ts,
 * reached from apps/web/src/pages/internal/purge.ts).
 *
 * ⚠️ ONE CALL PER EDIT, ALL TAGS BATCHED. The Free-zone purge limit is 5 requests
 * per MINUTE (burst 25, 100 operations per request). A call per tag would spend an
 * author's entire budget in under two edits and start silently dropping purges —
 * whose symptom is content that is stale for up to 25 hours.
 *
 * ⚠️ NEVER THROWS — the same contract as src/auth/email-verify.ts's
 * sendVerificationEmail, for the same reason: the post is ALREADY SAVED by the
 * time this runs, so a purge failure must not turn a successful edit into a 500.
 * ⚠️ AND THAT MEANS FAILURES ARE SILENT TO USERS. The only signal is the log
 * lines below, and the cost of missing them is content stale for a full
 * maxAge+swr window (25h). Alerting on `cache purge` is a DEPLOY-GATE item.
 *
 * ⚠️ AWAITED BY CALLERS, not fired into ctx.waitUntil(). The editor redirects to
 * the post page immediately after an edit; purging behind the response races that
 * redirect and can show the author their own stale post. Purge is ~10-50ms and
 * edits are rare.
 *
 * ⚠️ NO TEST IN THIS REPO OBSERVES A PURGE. Workers Cache is not simulated by
 * miniflare, so test/purge.test.ts can only pin the REQUEST this sends. That the
 * request invalidates anything at the edge is deploy-gate-only.
 */

/**
 * The URL host for the Service-Binding dispatch. A Service Binding dispatches on
 * the BINDING, not on DNS, so this is never resolved — but `fetch` still demands
 * a well-formed absolute URL. Deliberately not a real domain. (Mirrors
 * apps/web/src/lib/api.ts's SERVICE_ORIGIN.)
 */
const SERVICE_ORIGIN = "https://web.internal";

/**
 * The route on `web` that owns the cache (apps/web/src/pages/internal/purge.ts).
 *
 * ⚠️ NOT `/__internal/purge`, and the underscores are not a style choice. `web` is
 * Astro, whose router SKIPS any file or directory whose name starts with `_`
 * (verified at source: astro@7.0.9 dist/core/routing/create-manifest.js —
 * `if (name[0] === "_") { continue; }`). The plan's `__internal` path produced a
 * silent 404 with no warning anywhere: the route never entered the build
 * manifest. Observed live against both Workers under `wrangler dev`.
 *
 * ⚠️ The api's own `/__test/...` prefix works because THIS Worker hand-rolls its
 * router (src/routes.ts). That convention does not transfer to `web`.
 *
 * Both halves must agree on this literal; test/purge.test.ts pins it.
 */
const PURGE_PATH = "/internal/purge";

export async function purgeTags(env: Env, tags: readonly string[]): Promise<void> {
  const unique = [...new Set(tags)];
  if (unique.length === 0) return;

  try {
    const response = await env.WEB.fetch(`${SERVICE_ORIGIN}${PURGE_PATH}`, {
      // ⚠️ POST, and that is load-bearing: POST bypasses the cache
      // unconditionally, so this request always reaches the Worker and always
      // executes. A GET could be served from cache and purge nothing.
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The whole authorization story for that route — `web` is PUBLIC, so
        // `/internal/purge` is reachable from the internet and there is no way
        // to prove a request arrived over the binding. See its header.
        "X-Purge-Secret": env.PURGE_SECRET,
      },
      body: JSON.stringify({ tags: unique }),
    });

    if (!response.ok) {
      // Status only — the tags are not secret, but there is nothing to learn from
      // them either, and a log line per tag is a log line per edit.
      console.error("cache purge rejected", { status: response.status, tagCount: unique.length });
    }
  } catch (err) {
    // A dev-registry blip or a `web` that is not deployed yet must not 500 an
    // edit. ("Network connection lost" is the shape this takes locally when
    // `astro build` ran while a wrangler dev was alive — see the README.)
    console.error("cache purge threw", err);
  }
}
