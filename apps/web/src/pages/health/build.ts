/**
 * `GET /health/build` — the `web` Worker's OWN build identity. Deliberately
 * NOT a proxy to the api's `/health/build` (see api's health-build.ts) — the
 * two Workers deploy separately and can skew (main was ahead of the api's
 * last successful deploy as of 2026-09-24), and a shared/merged surface
 * would hide exactly that skew. Each Worker answers for itself.
 *
 * Two independent sources, reported together:
 *   - `sha`: `PUBLIC_BUILD_SHA`, inlined at build time by scripts/build-web.mjs
 *     via `git rev-parse --short HEAD` (Vite's `import.meta.env.PUBLIC_*`
 *     build-time substitution — same mechanism as PUBLIC_TURNSTILE_SITE_KEY).
 *     `null` if that script could not determine it (never fabricated).
 *   - `version`: Cloudflare's OWN `version_metadata` binding (`id`/`tag`/
 *     `timestamp`) — populated by Cloudflare's deploy infrastructure on
 *     every deploy, independent of any build script running at all.
 *
 * markPrivate — this reads live Worker state (env), never cache it.
 */
import { env } from "cloudflare:workers";

import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

// Not async: nothing here awaits anything (a pure sync env/env-var readout),
// and Astro's own APIRoute type accepts a plain `Response` return alongside
// `Promise<Response>` — no need for an async function with no `await`.
export const GET: APIRoute = (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  // ⚠️ `env` FROM `cloudflare:workers`, NOT `Astro.locals.runtime.env` — that
  // was REMOVED in Astro v6 and THROWS on access under the installed astro@7.
  // Same trap as src/lib/api.ts's and internal/purge.ts's headers.
  //
  // ⚠️ NO `meta ? ... : null` TERNARY: `CF_VERSION_METADATA` is a REQUIRED
  // binding (declared non-optional in worker-configuration.d.ts), so `meta`
  // is never falsy — that ternary was flagged as an always-truthy no-op
  // conditional and rightly so. `sha`, not `version`, is the field that can
  // genuinely be absent (PUBLIC_BUILD_SHA is only set on success).
  const meta = env.CF_VERSION_METADATA;
  const sha = import.meta.env.PUBLIC_BUILD_SHA as string | undefined;
  return new Response(
    JSON.stringify({
      worker: "web",
      sha: sha ?? null,
      version: { id: meta.id, tag: meta.tag, timestamp: meta.timestamp },
    }),
    { status: 200, headers },
  );
};
