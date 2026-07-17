/**
 * `POST /internal/purge` — the ONLY place cached renders are invalidated.
 *
 * ⚠️ WHY THIS EXISTS ON `web` AND NOT ON `api`. Workers Cache purge is scoped to
 * the Worker that OWNS the cache: `api` cannot reach into this Worker's cache, no
 * matter what it calls. So `api` (which knows an edit happened) asks THIS Worker
 * (which owns the cache) to purge — see apps/api/src/cache/purge.ts.
 *
 * ⚠️⚠️ DO NOT RENAME THIS DIRECTORY TO `__internal` (or anything starting with an
 * underscore). The plan specified `src/pages/__internal/purge.ts`; that path is
 * UNROUTABLE and fails SILENTLY. Astro's router skips any file OR DIRECTORY whose
 * name begins with `_` — verified at source in astro@7.0.9,
 * dist/core/routing/create-manifest.js:
 *
 *     const name = ext ? basename.slice(0, -ext.length) : basename;
 *     if (name[0] === "_") { continue; }
 *
 * There is NO warning and NO error: the route simply never enters the manifest.
 * Observed live against a built Worker under `wrangler dev` — every request to
 * `/__internal/purge` (right secret, wrong secret, no secret) returned Astro's
 * 404 page, and the built manifest contained no such route. The unit tests could
 * not see it, because they call `handlePurgeRequest` directly and never route.
 * The matching api-side path lives in apps/api/src/cache/purge.ts's PURGE_PATH
 * and must be changed with it; test/purge.test.ts there pins the literal.
 *
 * ⚠️ THE `__test` PREFIX ON THE api DOES NOT TRANSFER. `GET /__test/last-verify-token`
 * works there because the api hand-rolls its router (apps/api/src/routes.ts).
 * This Worker is Astro. Same repo, different routing rules.
 *
 * ⚠️ POST is load-bearing: POST bypasses the cache unconditionally, so this
 * always executes rather than being answered from cache. There is deliberately no
 * GET export — a cacheable purge is a purge that might not happen.
 *
 * THIS FILE IS GLUE. Every decision (the secret check, the tags, the invalidate)
 * lives in src/lib/purge.ts, which is testable in plain Node; this reads the
 * binding and declares cacheability. The two things it does are the two things
 * that cannot be done there.
 */
import { env } from "cloudflare:workers";

import { markPrivate } from "../../lib/cache";
import { handlePurgeRequest } from "../../lib/purge";

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  // ⚠️ `env` FROM `cloudflare:workers`, NOT `Astro.locals.runtime.env` — that was
  // REMOVED in Astro v6 and THROWS on access under the installed astro@7. Same
  // reasoning (and the same trap) as src/lib/api.ts's header.
  const response = await handlePurgeRequest(context, env.PURGE_SECRET);

  // ⚠️ THIS ROUTE DECLARES ITS CACHEABILITY LIKE EVERY OTHER PAGE, and is NOT
  // exempt from test/page-cache-inventory.test.ts. An earlier draft of the plan
  // pre-granted it an exemption; that was wrong. Sweep A's rule is that a file
  // under src/pages says what the edge may hold, and this file has a real answer:
  // nothing. A purge ACK is per-request and worthless to cache, and an exemption
  // would be a permanent hole in a default-deny inventory to spare one line.
  //
  // ⚠️ `markPrivate` NEEDS `response`, WHICH `APIContext` DOES NOT HAVE. Verified
  // against astro@7.0.9: `response` is declared on `AstroGlobal` (which extends
  // APIContext), not on APIContext itself — so a page can pass `Astro` but an API
  // route cannot pass `context`. Handing it THIS response's headers is the honest
  // equivalent: `cache.set(false)` still reaches the real cache object (which is
  // what protects the EDGE), and `cache-control: private, no-store` lands on the
  // response actually returned (which is what protects browsers/intermediaries).
  markPrivate({ request: context.request, response, cache: context.cache });

  return response;
};
