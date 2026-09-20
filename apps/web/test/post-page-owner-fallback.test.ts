import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #78 OWNER-VISIBLE FALLBACK — PM review condition 3, pinned directly.
 *
 * The owner branch of `[handle]/[slug].astro` (rendered via OwnerPostView.astro,
 * see that file's header for why it is split out) is the ONE code path in this
 * app that may carry a hidden or draft post's content to a browser. If it were
 * ever edge-cacheable, that content would be served to every anonymous visitor —
 * #61's exact failure, one layer up. This file pins BOTH halves of that
 * guarantee together: the owner view is markPrivate, ONLY markPrivate, and the
 * public page's own anonymous/cacheable branch is untouched by the split.
 *
 * Same anti-vacuity discipline as test/post-page.test.ts and
 * test/page-cache-inventory.test.ts: every negative below is preceded by a
 * positive proving we're looking at the real construct.
 */

const SLUG_PAGE = join(import.meta.dirname, "../src/pages/[handle]/[slug].astro");
const OWNER_VIEW = join(import.meta.dirname, "../src/components/OwnerPostView.astro");

/** Same technique as the other two files — comments can't satisfy a match. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const slugSource = stripComments(readFileSync(SLUG_PAGE, "utf8"));
const ownerSource = stripComments(readFileSync(OWNER_VIEW, "utf8"));

describe("OwnerPostView.astro — the hidden/draft-content branch is markPrivate, ONLY markPrivate", () => {
  it("positive: calls markPrivate(Astro)", () => {
    expect(ownerSource).toContain("markPrivate(Astro)");
  });

  it("⚠️ negative: never calls markPublicCacheable or markFeedCacheable — this branch may carry a hidden post", () => {
    // If either edge-cacheable helper is ever added here, a hidden/draft post's
    // owner-only render becomes servable to every anonymous visitor from the
    // edge cache. There is no legitimate reason for this file to call either.
    expect(ownerSource).not.toContain("markPublicCacheable(");
    expect(ownerSource).not.toContain("markFeedCacheable(");
  });

  it("imports markPrivate from the one sanctioned module, not a hand-rolled cache.set", () => {
    expect(ownerSource).toMatch(/import\s*\{[^}]*markPrivate[^}]*\}\s*from\s*["']\.\.\/lib\/cache["']/);
    expect(ownerSource).not.toMatch(/\bcache\.set\(/);
  });
});

describe("[handle]/[slug].astro — the split kept the public branch untouched", () => {
  it("⚠️ the page file itself never declares markPrivate — that declaration lives ONLY in OwnerPostView.astro", () => {
    // This is the structural half of condition 3: if `markPrivate(` ever appears
    // in THIS file's text, sweep A (test/page-cache-inventory.test.ts) would see
    // two distinct helper names and redden — but that test only proves "not
    // exactly one", not "which one is missing". This test names it directly: the
    // public page declares ONLY markPublicCacheable, full stop.
    expect(slugSource).not.toContain("markPrivate(");
  });

  it("positive: still declares markPublicCacheable for its (unchanged) public branch", () => {
    expect(slugSource).toContain("markPublicCacheable(Astro,");
  });

  it("renders OwnerPostView only on the exact fallback condition: post is null AND an owner match was found", () => {
    expect(slugSource).toContain("import OwnerPostView from");
    expect(slugSource).toMatch(/\{post === null && ownerPost !== null && <OwnerPostView post=\{ownerPost\} \/>\}/);
  });

  it("⚠️ the owner-only authenticated lookup never runs when the request carries no cookie", () => {
    // The other half of "an anonymous visitor never pays for, or triggers, the
    // owner path": the by-slug lookup is gated on a Cookie header being present,
    // so a truly anonymous request (a crawler, a bogus URL) takes exactly the
    // same code path it always did — one fetch, one 404 on failure.
    const gateAt = slugSource.indexOf("Astro.request.headers.get(\"Cookie\") !== null");
    expect(gateAt).toBeGreaterThan(-1);
    const byslugAt = slugSource.indexOf("/posts/by-slug?slug=");
    expect(byslugAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(byslugAt);
  });
});
