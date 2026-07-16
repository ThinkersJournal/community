import { describe, expect, it } from "vitest";

import { PUBLIC_PAGE_CSP, setPublicPageCsp } from "../src/lib/csp";

import type { CspContext } from "../src/lib/csp";

/**
 * THE CSP PIN — the layer that still holds IF THE SANITIZER FAILS.
 *
 * This page renders attacker-authored Markdown, and its output is edge-cached
 * and mass-served. rehype-sanitize is the first line; this policy is the second,
 * and it is the only one left standing on the day the first has a bug.
 *
 * ⚠️ EVERY ASSERTION HERE ASSERTS THE POSITIVE FIRST. A bare
 * `expect(csp).not.toContain("'unsafe-inline'")` against a header that is NULL
 * passes vacuously — it "proves" a policy that was never emitted. Worse, on THIS
 * header it would also be WRONG even when present, because `style-src`
 * legitimately carries 'unsafe-inline'. So the negatives below are scoped to a
 * SINGLE PARSED DIRECTIVE, and `directive()` throws rather than returns
 * undefined when the directive is missing.
 */
function context(): CspContext & { response: { headers: Headers } } {
  return { response: { headers: new Headers() } };
}

/** The emitted CSP, proven PRESENT. Never let a missing header reach an assertion. */
function emittedCsp(): string {
  const ctx = context();
  setPublicPageCsp(ctx);
  const header = ctx.response.headers.get("content-security-policy");
  // ⚠️ ANTI-VACUITY: `null` must fail here, not silently satisfy a `not.toContain`.
  expect(header, "no content-security-policy header was emitted at all").not.toBeNull();
  return header as string;
}

/**
 * The value of ONE directive, e.g. `directive(csp, "script-src")` -> `"'self'"`.
 *
 * ⚠️ THROWS when the directive is absent. That is the point: a negative
 * assertion against a directive that does not exist is exactly the vacuous pass
 * this file exists to prevent, and it is what MUTATION 2 (deleting
 * `script-src 'self'`) produces.
 */
function directive(csp: string, name: string): string {
  const found = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  if (found === undefined) {
    throw new Error(`CSP has no \`${name}\` directive. Emitted policy: ${csp}`);
  }
  return found.slice(name.length).trim();
}

describe("setPublicPageCsp", () => {
  it("emits a content-security-policy header at all (the tripwire)", () => {
    expect(emittedCsp()).toContain("script-src");
  });

  it("⚠️ script-src is exactly 'self' — NO 'unsafe-inline', ever", () => {
    // THE directive the whole policy exists for. Astro bundles <script> into
    // external modules, so nothing on this page needs inline script. If this
    // ever reddens because someone added 'unsafe-inline', the answer is to
    // remove it, not to update this test.
    const scriptSrc = directive(emittedCsp(), "script-src");
    // Positive first: prove we are looking at a real, expected value...
    expect(scriptSrc).toBe("'self'");
    // ...then the negative, scoped to THIS directive only.
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("style-src carries 'unsafe-inline' DELIBERATELY (shiki token styles)", () => {
    // Shiki emits an inline `style` attribute per token span and CSP has no
    // hash/nonce mechanism for style ATTRIBUTES. Safe ONLY because
    // rehype-sanitize's defaultSchema has no `style` in `attributes`, so USER
    // content can never carry one. Pinned so the reasoning is visible if it
    // ever needs revisiting — see src/lib/csp.ts.
    expect(directive(emittedCsp(), "style-src")).toBe("'self' 'unsafe-inline'");
  });

  it("⚠️ 'unsafe-inline' appears in style-src and NOWHERE else", () => {
    // The creep guard. The concession above is acceptable only while it stays
    // confined to styles; this fails the moment it spreads to another directive.
    const relaxed = PUBLIC_PAGE_CSP.split(";")
      .map((part) => part.trim())
      .filter((part) => part.includes("unsafe-inline"))
      .map((part) => part.split(" ")[0]);
    expect(relaxed).toEqual(["style-src"]);
  });

  it("locks down the cheap adds", () => {
    const csp = emittedCsp();
    expect(directive(csp, "object-src")).toBe("'none'");
    expect(directive(csp, "base-uri")).toBe("'none'");
    expect(directive(csp, "frame-ancestors")).toBe("'none'");
    expect(directive(csp, "default-src")).toBe("'self'");
    expect(directive(csp, "form-action")).toBe("'self'");
  });

  it("img-src allows the R2 custom domain and NOT data:", () => {
    // packages/markdown's schema blocks data: URLs in `src` outright, so
    // allowing them here would only widen what a sanitizer failure could reach.
    const imgSrc = directive(emittedCsp(), "img-src");
    expect(imgSrc).toBe("'self' https://cdn.thinkersjournal.com");
    expect(imgSrc).not.toContain("data:");
  });

  it("pins the EXACT policy (an unreviewed edit to the CSP must redden)", () => {
    expect(emittedCsp()).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' https://cdn.thinkersjournal.com; font-src 'self'; connect-src 'self'; " +
        "form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    );
  });

  it("sets the companion security headers", () => {
    const ctx = context();
    setPublicPageCsp(ctx);
    expect(ctx.response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ctx.response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("⚠️ sets NO cache header — cacheability is src/lib/cache.ts's alone", () => {
    // This helper must never touch caching. Two modules writing cache headers is
    // how a `public` directive lands on a response nobody meant to cache, and
    // nothing on a response can rescue an edge leak once that happens.
    const ctx = context();
    setPublicPageCsp(ctx);
    // ⚠️ ANTI-VACUITY: assert the helper DID something first. Without this line
    // the two null checks below would pass just as happily against a
    // setPublicPageCsp that never ran — "proving" a property of nothing. This is
    // the same shape as the `Cache-Control` trap that shipped in T12: a negative
    // assertion on an absent header is not evidence.
    expect(ctx.response.headers.get("content-security-policy")).toBe(PUBLIC_PAGE_CSP);
    expect(ctx.response.headers.get("cache-control")).toBeNull();
    expect(ctx.response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
  });
});
