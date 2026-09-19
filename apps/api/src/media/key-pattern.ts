/**
 * The ONE regex that finds a media reference inside stored markdown.
 *
 * Shared by `reap-orphan-media.ts` (is this key referenced by ANY post) and
 * the #61 visibility/legal-hold machinery (is this key referenced by a
 * PUBLICLY VISIBLE post/comment) so the two can never drift on what counts as
 * "referenced". Matches `mediaKey()` in `src/routes/media.ts`.
 */
export const MEDIA_KEY_SQL_PATTERN = "media/post/([0-9a-f]{64})\\.webp";

/** `mediaKey()`'s inverse: the sha256 back to its r2_key. */
export function r2KeyForSha256(sha256: string): string {
  return `media/post/${sha256}.webp`;
}
