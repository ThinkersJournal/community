import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PAGE = join(import.meta.dirname, "../src/pages/choose-username.astro");
const SERVER_ENTRY = join(import.meta.dirname, "../dist/server/entry.mjs");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(readFileSync(PAGE, "utf8"));

describe("choose-username.astro", () => {
  it("declares its cacheability via markPrivate (never cacheable — it is authed)", () => {
    expect(code).toContain("markPrivate(");
    expect(code).not.toContain("markPublicCacheable(");
    expect(code).not.toContain("markFeedCacheable(");
  });

  it("posts the chosen handle to the api username route with the CSRF token", () => {
    expect(code).toContain("/profile/username");
    expect(code).toMatch(/csrfToken/);
  });

  it("forwards the browser cookie on its api calls (it is an authed page)", () => {
    expect(code).toMatch(/request:\s*Astro\.request/);
  });

  it("branches on the api error codes, not raw status", () => {
    expect(code).toContain("USERNAME_TAKEN");
    expect(code).toContain("apiErrorCode(");
  });

  it("redirects to /feed by default when no ?next= is present at all", () => {
    expect(code).toMatch(/raw\s*===\s*null\s*\?\s*["']\/feed["']\s*:\s*resolveNext\(raw,\s*Astro\.url\)/);
  });

  it("⚠️ honors a ?next= param on every success/redirect path, via the shared `dest`", () => {
    // Positive first (anti-vacuity): `dest` is actually computed from `next`.
    expect(code).toContain('Astro.url.searchParams.get("next")');
    // All three redirect sites (already-onboarded GET short-circuit, POST
    // success, USERNAME_ALREADY_SET — the latter two share one code path)
    // use `dest`, never a hardcoded "/feed".
    expect(code).toMatch(/Astro\.redirect\(dest\)/);
    expect(code).toMatch(/Location:\s*dest/);
  });

  it("⚠️ delegates the open-redirect guard to the shared, hardened `resolveNext` helper — not a hand-rolled check", () => {
    // A prior hand-rolled `isSafeLocalPath` (leading-`/`-and-no-`:` check) was
    // bypassable via `/\evil.com` (browsers normalize `\` to `/`, landing on
    // `//evil.com` — scheme-relative, off-origin). Rather than re-patch that
    // regex, this page must delegate to the SAME hardened guard login.astro
    // uses — see src/lib/next-url.ts and its exhaustive hostile corpus in
    // test/next-url.test.ts (which already covers `/\evil.com`, `//evil.com`,
    // `/..//evil.com`, `javascript:`, `blob:`, the `@`-userinfo trick, etc.)
    // — no need to duplicate that corpus here.
    expect(code).toContain('import { resolveNext } from "../lib/next-url"');
    expect(code).not.toMatch(/function isSafeLocalPath/);
    expect(code).not.toContain("isSafeLocalPath");
    expect(code).toMatch(/resolveNext\(raw,\s*Astro\.url\)/);
  });

  it("⚠️ handles EMAIL_NOT_VERIFIED and links to the existing /verify-email page — not an invented resend route", () => {
    // The brief's Behavior section requires a resend/verify affordance on this
    // branch. verify-email.astro is where that affordance actually lives (it
    // hosts BOTH the token-verify GET and the `POST /auth/resend-verification`
    // form) — there is no separate /resend-verification page, so this must
    // link to /verify-email specifically, not a route that does not exist.
    expect(code).toContain("EMAIL_NOT_VERIFIED");
    expect(code).toContain("/verify-email");
  });

  it("carries the error CODE (not just the message string) to the template", () => {
    // Needed to conditionally render the verify-email link on ONLY the
    // EMAIL_NOT_VERIFIED case, never on USERNAME_TAKEN or the generic default.
    expect(code).toMatch(/errorCode\s*===\s*["']EMAIL_NOT_VERIFIED["']/);
  });

  it("adopts the shared chrome + CSP while staying markPrivate", () => {
    // `code` is the comment-stripped source already read in this file
    expect(code).toMatch(/<BaseLayout\s/);
    expect(code).toContain("setPublicPageCsp(Astro)");
    expect(code).toContain("markPrivate(Astro)");
  });
});

describe("⚠️ Set-Cookie propagation on the redirect paths — the login.astro / new-post.astro Astro.redirect() bug", () => {
  it("builds the /feed redirects by hand and applies cookies to THAT response, not Astro.redirect()", () => {
    // Astro.redirect() builds a response it owns itself, which does not carry
    // Astro.response.headers — a Set-Cookie from the just-preceding apiFetch
    // call would be silently dropped on the very response that navigates the
    // browser away. login.astro and new-post.astro document this exact bug and
    // use this exact fix: build the Response by hand, applyCookies onto ITS
    // headers, then return it. Both /feed redirects here (200 success and
    // USERNAME_ALREADY_SET) must use it.
    const redirectBuilds = code.match(/new Response\(null,\s*\{\s*status:\s*302/g) ?? [];
    expect(redirectBuilds.length).toBeGreaterThanOrEqual(1);
    const applyOnRedirect = code.match(/applyCookies\(redirect\.headers, response\.setCookies\)/g) ?? [];
    expect(applyOnRedirect.length).toBeGreaterThanOrEqual(1);
  });

  it("the already-onboarded GET-probe redirect is the ONLY remaining Astro.redirect() call", () => {
    // That probe never applies cookies (no authed POST happened on this path),
    // so a plain Astro.redirect is fine there — unlike the two POST-success
    // paths above, which now build their own Response.
    const astroRedirects = code.match(/Astro\.redirect\(/g) ?? [];
    expect(astroRedirects.length).toBe(1);
  });

  it("still applies cookies on the re-render (error) path via Astro.response.headers", () => {
    expect(code).toContain("applyCookies(Astro.response.headers, response.setCookies)");
  });
});

describe("built route manifest (when dist/ is present)", () => {
  const built = existsSync(SERVER_ENTRY);
  it.runIf(built)("contains the /choose-username route", () => {
    expect(readFileSync(SERVER_ENTRY, "utf8")).toContain('"route":"/choose-username"');
  });
  it.skipIf(built)("SKIPPED: no dist/ — reachability is E2E + deploy-gate verified", () => {
    expect(built).toBe(false);
  });
});
