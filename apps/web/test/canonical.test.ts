import { describe, expect, it } from "vitest";

import { CANONICAL_ORIGIN, postUrl, profileUrl } from "../src/lib/canonical";

/**
 * ⚠️ THE POINT OF THESE TESTS IS THAT THE ORIGIN IS A CONSTANT.
 *
 * HOST IS NOT IN THE WORKERS CACHE KEY. A canonical/OG URL derived from
 * `Astro.url` (i.e. from the client-supplied Host header) would be cached with
 * WHICHEVER host filled the entry first and then served under all of them —
 * apex, www, and *.workers.dev alike. These functions take no request and cannot
 * see a host, which is what makes that mistake unavailable rather than merely
 * discouraged.
 */
describe("canonical URLs", () => {
  it("is an absolute https origin with no trailing slash", () => {
    // A trailing slash would double up in `${origin}/@user` -> `//@user`.
    expect(CANONICAL_ORIGIN).toBe("https://thinkersjournal.com");
    expect(CANONICAL_ORIGIN.endsWith("/")).toBe(false);
  });

  it("builds a profile URL with the @ prefix", () => {
    expect(profileUrl("ada")).toBe("https://thinkersjournal.com/@ada");
  });

  it("builds a post URL under the profile", () => {
    expect(postUrl("ada", "hello-world")).toBe("https://thinkersjournal.com/@ada/hello-world");
  });

  it("percent-encodes a slug that would otherwise escape the path", () => {
    // Defense in depth. Slugs are generated server-side, but a URL built by
    // string concatenation is one bad input away from pointing somewhere else
    // entirely — and this value lands in <link rel="canonical"> and og:url.
    expect(postUrl("ada", "a/../../evil")).toBe("https://thinkersjournal.com/@ada/a%2F..%2F..%2Fevil");
  });

  it("percent-encodes a username", () => {
    expect(profileUrl("a b")).toBe("https://thinkersjournal.com/@a%20b");
  });

  it("produces a parseable URL whose origin is always ours", () => {
    // The property that actually matters: whatever the input, the result cannot
    // point at another origin.
    expect(new URL(postUrl("ada", "x")).origin).toBe(CANONICAL_ORIGIN);
    expect(new URL(postUrl("evil.com/x", "y")).origin).toBe(CANONICAL_ORIGIN);
  });
});
