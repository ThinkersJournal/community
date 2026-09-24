/**
 * `GET /health/build` — the `api` Worker's OWN build identity, independent
 * of `web`'s (endpoint/UI audit follow-up, 2026-09-24; CireSnave: "get it
 * implemented"). Two Workers deploy separately and CAN skew — main was
 * ahead of the api's last successful Workers Builds deploy as of
 * 2026-09-24, and the only way to learn that today is reading Cloudflare's
 * build history by hand. Each Worker reporting its own identity is what
 * makes that skew visible from the outside instead of hidden by a
 * merged/shared surface.
 *
 * ⚠️ NO `sha` FIELD HERE, AND THAT IS DELIBERATE, NOT A GAP LEFT FOR LATER.
 * The `web` Worker's `/health/build` (apps/web/src/pages/health/build.ts)
 * gets a real git SHA because `scripts/build-web.mjs` — THIS REPO'S OWN
 * `apps/web` build script — runs `git rev-parse --short HEAD` and bakes it
 * in via Vite's `import.meta.env.PUBLIC_*` inlining, a mechanism already
 * proven live (the same one `PUBLIC_TURNSTILE_SITE_KEY` uses). The `api`
 * Worker has NO equivalent: `apps/api/package.json` has no `build` script,
 * there is no `.github/workflows/deploy.yml`, and Workers Builds deploys it
 * via a command configured on Cloudflare's dashboard that this repo cannot
 * see or run locally — there is nothing here to hook a git-SHA-baking step
 * onto. Guessing a build-time env var name (`WORKERS_CI_COMMIT_SHA` or
 * similar) and trusting it unverified is exactly the mistake #89's own
 * Turnstile guard was built to stop repeating. So: no fabricated field, no
 * asserted-but-unverified one either — see the PM/CireSnave dispatch this
 * answers for the open question of whether the dashboard's api build
 * command can be changed to make a real SHA obtainable here too.
 *
 * `version` — Cloudflare's OWN `version_metadata` binding (`id`/`tag`/
 * `timestamp`), populated by Cloudflare's deploy infrastructure on EVERY
 * deploy regardless of build command. This is what IS obtainable, unasked,
 * for both Workers: enough to prove the two Workers are on different
 * versions (skew, requirement #1) and to answer "which is newer"
 * (`timestamp`, requirement #4) even without a git SHA.
 *
 * No auth, no DB, no KV — pure runtime binding readout, same reasoning as
 * `GET /health` (ERROR_FREE in test/error-envelope.test.ts): nothing here
 * can fail short of the Worker not running at all.
 */
// Two params, not the full four-param RouteHandler shape — matches
// handleCsrf's identical minimal signature (a function requiring fewer
// params satisfies a type requiring more, TypeScript's own trailing-args
// bivariance), and avoids declaring `ctx`/`params` just to prefix them
// `_` and never touch them. Not `async` either — there is no `await` in
// this body (a pure sync readout), and `Promise.resolve` alone satisfies
// RouteHandler's `Promise<Response>` return type without an async
// function Codacy flags for having no `await` expression.
export function handleHealthBuild(_request: Request, env: Env): Promise<Response> {
  const meta = env.CF_VERSION_METADATA;
  return Promise.resolve(
    new Response(
      JSON.stringify({
        worker: "api",
        version: { id: meta.id, tag: meta.tag, timestamp: meta.timestamp },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}
