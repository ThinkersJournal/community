/**
 * `GET /rss.xml` — the site-wide feed of the 20 most recent published posts.
 *
 * ⚠️ Same shape and same reasoning as sitemap.xml: UNTAGGED, short-TTL, which is
 * what licenses `GET /public/recent`'s `HYPERDRIVE_CACHED` read (see that page's
 * header, and apps/api/src/routes/public.ts's). A subscriber seeing a post up to
 * ~2 minutes late (60s edge + 60s Hyperdrive) is normal for RSS.
 *
 * ⚠️ EXCERPTS, NOT BODIES — see src/lib/xml.ts's `buildRssXml`.
 *
 * ⚠️ "UNTAGGED" — see sitemap.xml.ts's header for the measured correction: a
 * `cache-tag: astro-path:/rss.xml` header IS present on the wire (Astro core's
 * own unconditional path tag), but nothing in this application's purge flow
 * ever targets it, which is the property the CACHED binding actually depends on.
 *

 * ⚠️ NO CSP — see sitemap.xml.ts's header for why an HTML CSP is meaningless on
 * an `application/rss+xml` document.
 */
import type { RecentPost } from "@thinkersjournal/shared";
import type { APIRoute } from "astro";

import { apiFetch } from "../lib/api";
import { markFeedCacheable } from "../lib/cache";
import { buildRssXml } from "../lib/xml";

export const prerender = false;

/** How many items the feed carries. The api's `?limit=` is the single source of
 * truth for this count — src/lib/xml.ts's buildRssXml deliberately does not
 * re-bound it. */
const FEED_ITEMS = 20;

export const GET: APIRoute = async (context) => {
  // ⚠️ See sitemap.xml.ts's header: an APIRoute's `context` has NO `.response`.
  const headers = new Headers({ "content-type": "application/rss+xml; charset=utf-8" });
  markFeedCacheable({ request: context.request, response: { headers }, cache: context.cache });

  // ⚠️ ANONYMOUS — no `request`. See src/lib/cache.ts.
  const response = await apiFetch<{ posts: RecentPost[] }>(`/public/recent?limit=${FEED_ITEMS}`);
  const posts = response.status === 200 ? (response.data?.posts ?? []) : [];

  return new Response(buildRssXml(posts), { status: 200, headers });
};
