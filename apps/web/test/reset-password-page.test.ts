import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #70 — src/pages/reset-password.astro.
 *
 * ⚠️ SOURCE/STRUCTURE TEST, NOT A RENDER — same reasoning as
 * forgot-password-page.test.ts. The live flow is proven end to end at the
 * api layer in apps/api/test/reset-password.test.ts.
 */

const PAGE = join(import.meta.dirname, "../src/pages/reset-password.astro");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(readFileSync(PAGE, "utf8"));

describe("reset-password.astro", () => {
  it("adopts the shared chrome + CSP while staying markPrivate", () => {
    expect(code).toMatch(/<BaseLayout\s/);
    expect(code).toContain("setPublicPageCsp(Astro)");
    expect(code).toContain("markPrivate(Astro)");
    expect(code).not.toContain("markPublicCacheable(");
  });

  it("⚠️ still builds the success redirect BY HAND and never via Astro.redirect() — the Set-Cookie-drop bug", () => {
    // Same reasoning as login.astro/login-page.test.ts: Astro.redirect()
    // does not carry Astro.response.headers, and this response mints the
    // POST-reset session.
    expect(code).toMatch(/new Response\(null,\s*\{\s*status:\s*302/);
    expect(code).toContain("applyCookies(redirect.headers, response.setCookies)");
    expect(code).not.toMatch(/Astro\.redirect\(/);
  });

  it("still forwards the real browser Origin, never a synthesized one", () => {
    expect(code).toContain('Astro.request.headers.get("Origin")');
  });

  it("reads the token from ?token= and carries it forward as a hidden field", () => {
    expect(code).toMatch(/Astro\.url\.searchParams\.get\(\s*["']token["']\s*\)/);
    expect(code).toMatch(/<input\s+type="hidden"\s+name="token"/);
  });

  it("distinguishes an invalid/expired token from a plain validation failure", () => {
    expect(code).toContain('apiErrorCode(response) === "INVALID_RESET_TOKEN"');
  });

  it("the password field enforces the 12-char floor client-side too (defense in depth, not the authority)", () => {
    expect(code).toMatch(/type="password"[^>]*minlength="12"|minlength="12"[^>]*type="password"/);
  });
});
