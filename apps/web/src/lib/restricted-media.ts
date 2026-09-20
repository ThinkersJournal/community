/**
 * Rewrites public CDN image URLs in rendered post HTML to the restricted-media
 * proxy (`/api/media-restricted`), for the ONE case they stop being fetchable
 * at their original address: the author previewing their OWN hidden post.
 *
 * ⚠️ WHY THIS EXISTS AT ALL — the other half of community#61/#73. Hiding a
 * post moves its unshared media off the public `cdn.thinkersjournal.com`
 * bucket (apps/api/src/media/visibility-hook.ts); CireSnave's ruling on #26 is
 * that the author must still be able to see it. Skipping this rewrite would
 * satisfy a Hide button and fail the actual requirement — the author would see
 * broken images the moment their own post is hidden.
 *
 * A pure string function, not a DOM operation: `renderMarkdown`'s output is
 * sanitized HTML already destined for `set:html` (new-post.astro), and running
 * it back through a DOM parser here would be a second, redundant HTML engine
 * for something a regex on one well-known URL shape does correctly.
 */

/** Matches exactly `mediaKey()`'s shape (apps/api/src/routes/media.ts) — the ONLY URL form ever embedded by the upload flow. */
const MEDIA_CDN_IMAGE_URL_RE =
  /https:\/\/cdn\.thinkersjournal\.com\/media\/post\/([0-9a-f]{64})\.webp/g;

/**
 * @param html Rendered post HTML (from `renderMarkdown`).
 * @param postId The post whose (hidden) visibility state authorizes the fetch —
 *   forwarded as `?postId=` so `/api/media-restricted` can pass `subjectId` to
 *   the api's `GET /media/restricted/:sha256?subject=post&subjectId=...`.
 */
export function toRestrictedMediaUrls(html: string, postId: string): string {
  return html.replace(
    MEDIA_CDN_IMAGE_URL_RE,
    (_match, sha256: string) => `/api/media-restricted?sha256=${sha256}&postId=${encodeURIComponent(postId)}`,
  );
}
