import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * MINIMAL STRUCTURE TEST — src/pages/login.astro (Task 10 theming retrofit).
 *
 * ⚠️ SOURCE/STRUCTURE TEST, NOT A RENDER — same reasoning as
 * test/choose-username-page.test.ts: this app's vitest is plain Node, and the
 * page imports `cloudflare:workers` (via src/lib/api.ts), which does not
 * resolve outside workerd.
 *
 * This file exists ONLY to pin the theming retrofit (BaseLayout + CSP) without
 * disturbing the page's own logic, which stays proven elsewhere (the manual
 * 302 + applyCookies is exhaustively commented in the page itself, and the
 * live flow is proven by e2e/signup.spec.ts and e2e/resend-verification.spec.ts,
 * both of which log in through this exact page).
 */

const PAGE = join(import.meta.dirname, "../src/pages/login.astro");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(readFileSync(PAGE, "utf8"));

describe("login.astro", () => {
  it("adopts the shared chrome + CSP while staying markPrivate", () => {
    // `code` is the comment-stripped source already read in this file
    expect(code).toMatch(/<BaseLayout\s/);
    expect(code).toContain("setPublicPageCsp(Astro)");
    expect(code).toContain("markPrivate(Astro)");
  });

  it("⚠️ still builds the success redirect BY HAND and never via Astro.redirect() — the Set-Cookie-drop bug", () => {
    // Astro.redirect() builds a response it owns itself, which does not carry
    // Astro.response.headers — the api's Set-Cookie (the session this page
    // just minted) would be silently dropped on the very response that
    // navigates the browser away. See the page's own header comment.
    expect(code).toMatch(/new Response\(null,\s*\{\s*status:\s*302/);
    expect(code).toContain("applyCookies(redirect.headers, response.setCookies)");
    expect(code).not.toMatch(/Astro\.redirect\(/);
  });

  it("still forwards the real browser Origin, never a synthesized one, on the login POST", () => {
    expect(code).toContain('Astro.request.headers.get("Origin")');
  });
});
