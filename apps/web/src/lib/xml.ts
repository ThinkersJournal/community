/**
 * XML generation for `sitemap.xml` and `rss.xml` — the escaper, and the two feed
 * BODIES themselves.
 *
 * ⚠️ WHY THE BUILDERS LIVE HERE AND NOT INLINE IN THE PAGE FILES. Same split as
 * src/lib/purge.ts vs. src/pages/internal/purge.ts: the page files hold the api
 * call + the cache declaration (the two things that need `cloudflare:workers` /
 * `Astro`'s cache object and therefore cannot run under this app's plain-node
 * vitest — see vitest.config.ts's header). Everything that decides what BYTES go
 * on the wire is a PURE function here, so test/xml.test.ts can feed it
 * adversarial post data and parse the result with a real XML parser. Without
 * this split, "the generated feed is well-formed" would be unprovable by any
 * unit test — only observable on the wire, after the fact, per post.
 */
import { markdownExcerpt } from "@thinkersjournal/markdown";

import { CANONICAL_ORIGIN, postUrl, profileUrl } from "./canonical";

import type { RecentPost } from "@thinkersjournal/shared";

/** The site-wide feed's display name. Shared so the channel `<title>` and the
 * `<link rel="alternate">` on post/profile pages cannot silently drift apart. */
export const FEED_TITLE = "Thinker's Journal";

/**
 * An unpaired UTF-16 surrogate — cannot be encoded as valid UTF-8, so a
 * serializer either throws or silently substitutes U+FFFD, and XML 1.0's `Char`
 * production does not accept one either way. `packages/markdown`'s
 * `markdownExcerpt` truncates on CODE POINTS specifically so it can never
 * PRODUCE one by cutting a pair in half (see that module's header) — but the
 * post TITLE is interpolated directly below and never passes through
 * `markdownExcerpt` at all, so it is not covered by that guarantee. Replacing
 * here means well-formedness does not depend on an assumption about what
 * upstream storage would or would not have already sanitized.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Every C0 control character XML 1.0 forbids. Its `Char` production allows only
 * TAB (U+0009), LF (U+000A) and CR (U+000D) below U+0020 — every OTHER control
 * character (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F) is illegal in a
 * well-formed document, escaped or not: there is no numeric character reference
 * for them either (`&#x01;` is ITSELF malformed XML). `markdownExcerpt` does
 * nothing about this — it guards code points, not the C0 control range — so a
 * post body containing a raw control byte (a paste artifact, a bad upload)
 * reaches this function untouched. Left in place, it would make the ENTIRE feed
 * document malformed: a feed reader rejects the WHOLE thing on one bad item, not
 * just that item.
 */
// Built from `String.fromCharCode` rather than a `\u00XX`-style regex literal —
// deliberately: those control code points are unreadable and easy to fat-finger
// inside a literal (an off-by-one here silently narrows or widens what "illegal"
// means), and several editors/diff tools render raw control bytes inconsistently.
const controlChar = (codePoint: number): string => String.fromCharCode(codePoint);
const XML_ILLEGAL_CONTROL_CHARS = new RegExp(
  `[${controlChar(0x00)}-${controlChar(0x08)}${controlChar(0x0b)}${controlChar(0x0c)}${controlChar(0x0e)}-${controlChar(0x1f)}]`,
  "g",
);

/**
 * Escape text for interpolation into an XML element or attribute.
 *
 * ⚠️ `&` MUST be replaced FIRST or the other replacements' ampersands are
 * double-escaped (`&lt;` -> `&amp;amp;lt;`). Same trap, same order, as
 * apps/api/src/auth/email-verify.ts's escapeHtml.
 *
 * ⚠️ THIS IS A REAL INJECTION DEFENSE. Titles and excerpts go into sitemap.xml
 * and rss.xml as raw string interpolation — Astro's templating is nowhere near
 * these files. A post titled `</title><script>alert(1)</script>` would otherwise
 * break out of the element, into a document plenty of feed readers render as
 * HTML. Neither the title nor the excerpt ever passes through packages/markdown,
 * so nothing else guards this path.
 *
 * ⚠️ NOT JUST METACHARACTER ESCAPING — also strips what escaping cannot fix
 * (illegal control characters have no valid escape) and repairs what truncation
 * elsewhere cannot cause here (an unpaired surrogate in a TITLE, which is never
 * truncated). See the two module constants above.
 */
export function escapeXml(value: string): string {
  return value
    .replace(LONE_SURROGATE, "�")
    .replace(XML_ILLEGAL_CONTROL_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * `GET /sitemap.xml`'s body.
 *
 * ⚠️ The api caps `/public/recent` at 1000. The sitemap protocol's limit is
 * 50,000 URLs / 50MB, so we are far inside it — but a sitemap INDEX (and real
 * pagination on that route) is required before this site has 50k posts. M2.
 */
export function buildSitemapXml(posts: readonly RecentPost[]): string {
  // Unique authors — a profile is a page too, and this avoids a second query.
  const profiles = [...new Set(posts.map((p) => p.username))];

  const urls = [
    `<url><loc>${escapeXml(CANONICAL_ORIGIN)}/</loc></url>`,
    ...profiles.map((u) => `<url><loc>${escapeXml(profileUrl(u))}</loc></url>`),
    ...posts.map(
      (p) =>
        `<url><loc>${escapeXml(postUrl(p.username, p.slug))}</loc><lastmod>${escapeXml(
          new Date(p.updatedAt).toISOString(),
        )}</lastmod></url>`,
    ),
  ].join("");

  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

/**
 * `GET /rss.xml`'s body — the site-wide feed of recent published posts.
 *
 * ⚠️ EXCERPTS, NOT BODIES. The feed carries `<description>` only — never
 * rendered HTML. Feed readers are a wildly varied set of HTML renderers with
 * their own sanitizers (or none), so shipping post bodies would put our XSS
 * posture in their hands. It also keeps the feed small and drives readers to the
 * page.
 *
 * Does NOT itself bound how many `posts` it renders — the caller (rss.xml.ts)
 * asks the api for at most 20 via `?limit=`. Bounding here too would be a second
 * place to keep in sync with the actual number a reader sees; the api's LIMIT is
 * the one source of truth for "how many," same as sitemap's is "which ones."
 */
export function buildRssXml(posts: readonly RecentPost[]): string {
  const items = posts
    .map((post) => {
      const url = postUrl(post.username, post.slug);
      return (
        `<item>` +
        `<title>${escapeXml(post.title)}</title>` +
        `<link>${escapeXml(url)}</link>` +
        // A permanent, stable identifier — the post's uuid, not its URL, which a
        // future slug policy could change under subscribers.
        `<guid isPermaLink="false">${escapeXml(post.id)}</guid>` +
        `<pubDate>${escapeXml(new Date(post.publishedAt).toUTCString())}</pubDate>` +
        `<description>${escapeXml(markdownExcerpt(post.excerptSource))}</description>` +
        `</item>`
      );
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>` +
    `<title>${escapeXml(FEED_TITLE)}</title>` +
    `<link>${escapeXml(CANONICAL_ORIGIN)}/</link>` +
    `<description>Posts from thinkers.</description>` +
    `<atom:link href="${escapeXml(CANONICAL_ORIGIN)}/rss.xml" rel="self" type="application/rss+xml" />` +
    items +
    `</channel></rss>`
  );
}
