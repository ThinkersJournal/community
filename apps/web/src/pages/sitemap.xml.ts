/**
 * `GET /sitemap.xml`.
 *
 * ⚠️ UNTAGGED AND SHORT-TTL, AND THAT IS WHY `GET /public/recent` MAY READ
 * THROUGH `HYPERDRIVE_CACHED`. Nothing purges this entry, so the first render
 * after an edit is not a read-after-write and Hyperdrive's 60s window is a
 * subset of the 60s staleness this TTL already accepts (`markFeedCacheable`,
 * src/lib/cache.ts). ⚠️ ADD A CACHE TAG HERE AND THAT REASONING COLLAPSES — a
 * purge would then re-cache a stale listing for the full window. The binding in
 * apps/api/src/routes/public.ts's `handlePublicRecent` would have to change with
 * it (and apps/api/test/hyperdrive-binding-inventory.node.test.ts would need to
 * move its expectation, not just tolerate a second call site).
 *
 * A crawler that sees a post 60s late is not a defect; that is the whole reason
 * this shape exists.
 *
 * ⚠️ "UNTAGGED" MEANS "OUR PURGE FLOW NEVER TARGETS THIS ENTRY," NOT "the
 * `cache-tag` response header is absent." MEASURED on the wire (see the task
 * report): a `markFeedCacheable`-cacheable response DOES carry a `cache-tag`
 * header locally — `astro-path:/sitemap.xml`. That comes from Astro CORE
 * (astro/dist/core/cache/provider-utils.js's `collectInvalidationTags`), which
 * unconditionally appends `astro-path:<path>` to WHATEVER tags a page passes —
 * `markPublicCacheable`'s pages get it too, alongside their real tags. Passing
 * `tags: []` here does not, and cannot, suppress it. The property that actually
 * matters still holds: apps/web/src/lib/purge.ts's `context.cache.invalidate()`
 * is only ever called with `post:<id>` / `author:<id>` / `listing` (see
 * apps/api/src/routes/posts.ts's `purgeTags` call sites) — NEVER an
 * `astro-path:` tag — so nothing in this application purges this entry, which
 * is the actual claim the HYPERDRIVE_CACHED reasoning above depends on.
 *
 * ⚠️ NO CSP. `setPublicPageCsp` (src/lib/csp.ts) governs an HTML rendering
 * context — script-src/style-src/img-src etc. — none of which apply to a
 * `application/xml` document, which no browser executes as a page. The
 * injection defense for THIS content type is `escapeXml`
 * (src/lib/xml.ts): no markup can survive into the response at all, escaped or
 * not, so there is no script-execution surface for a CSP to constrain.
 */
import type { RecentPost } from "@thinkersjournal/shared";
import type { APIRoute } from "astro";

import { apiFetch } from "../lib/api";
import { markFeedCacheable } from "../lib/cache";
import { buildSitemapXml } from "../lib/xml";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  // ⚠️ An APIRoute's `context` has NO `.response` — that exists only on the
  // `AstroGlobal` a PAGE gets (astro@7.0.9; see src/lib/csp.ts's header and
  // src/pages/internal/purge.ts for the same correction, made there for the
  // identical reason). Build a real `Headers` object, hand markFeedCacheable a
  // CacheContext-shaped wrapper over it, then reuse the SAME headers on the
  // Response actually returned below.
  const headers = new Headers({ "content-type": "application/xml; charset=utf-8" });
  markFeedCacheable({ request: context.request, response: { headers }, cache: context.cache });

  // ⚠️ ANONYMOUS — no `request` passed to apiFetch, so no Cookie is forwarded. A
  // sitemap that varied by viewer would be cached under one viewer and served to
  // every crawler.
  const response = await apiFetch<{ posts: RecentPost[] }>("/public/recent");
  const posts = response.status === 200 ? (response.data?.posts ?? []) : [];

  return new Response(buildSitemapXml(posts), { status: 200, headers });
};
