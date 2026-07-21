/**
 * The canonical public origin.
 *
 * ⚠️ NEVER derived from `Astro.url` / the request's Host header. Host is
 * client-supplied AND — critically — HOST IS NOT IN THE WORKERS CACHE KEY, so a
 * render is shared across apex, www, and *.workers.dev. A canonical/OG URL built
 * from the request would be cached with WHICHEVER host happened to fill the entry
 * first and then served under all of them. A constant is the only correct answer.
 * (Same reasoning as apps/api/src/routes/signup.ts's CANONICAL_ORIGIN.)
 *
 * The functions below take no request and therefore CANNOT see a host — the
 * mistake is unavailable here, not merely discouraged. test/canonical.test.ts
 * pins that the resulting origin is always ours whatever the input.
 */
export const CANONICAL_ORIGIN = "https://community.thinkersjournal.com";

export function profileUrl(username: string): string {
  return `${CANONICAL_ORIGIN}/@${encodeURIComponent(username)}`;
}

export function postUrl(username: string, slug: string): string {
  return `${profileUrl(username)}/${encodeURIComponent(slug)}`;
}
