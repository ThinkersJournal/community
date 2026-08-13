import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * MINIMAL STRUCTURE TEST — src/pages/verify-email.astro (Task 10 theming
 * retrofit).
 *
 * ⚠️ SOURCE/STRUCTURE TEST, NOT A RENDER — same reasoning as
 * test/login-page.test.ts: this app's
 * vitest is plain Node, and the page imports `cloudflare:workers` (via
 * src/lib/api.ts), which does not resolve outside workerd. The runtime
 * behaviour (including the LOGIN_REQUIRED ripple and the resend-form CSRF
 * round trip) is proven by e2e/resend-verification.spec.ts.
 */

const PAGE = join(import.meta.dirname, "../src/pages/verify-email.astro");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const rawSource = readFileSync(PAGE, "utf8");
const code = stripComments(rawSource);

describe("verify-email.astro", () => {
  it("adopts the shared chrome + CSP while staying markPrivate", () => {
    // `code` is the comment-stripped source already read in this file
    expect(code).toMatch(/<BaseLayout\s/);
    expect(code).toContain("setPublicPageCsp(Astro)");
    expect(code).toContain("markPrivate(Astro)");
  });

  it("still carries the ?next= login bounce and the hidden CSRF resend form", () => {
    expect(code).toContain("loginHref");
    expect(rawSource).toMatch(/<input\s+type="hidden"\s+name="csrfToken"/);
    expect(rawSource).toContain('action="/verify-email"');
  });

  it("still applies cookies on the resend 401 revocation path", () => {
    expect(code).toContain("applyCookies(Astro.response.headers, response.setCookies)");
  });
});
