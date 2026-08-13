import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * MINIMAL STRUCTURE TEST — src/pages/signup.astro (Task 10 theming retrofit).
 *
 * ⚠️ SOURCE/STRUCTURE TEST, NOT A RENDER — same reasoning as
 * test/login-page.test.ts: this app's
 * vitest is plain Node, and the page imports `cloudflare:workers` (via
 * src/lib/api.ts), which does not resolve outside workerd.
 */

const PAGE = join(import.meta.dirname, "../src/pages/signup.astro");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const rawSource = readFileSync(PAGE, "utf8");
const code = stripComments(rawSource);

describe("signup.astro", () => {
  it("adopts the shared chrome + CSP while staying markPrivate", () => {
    // `code` is the comment-stripped source already read in this file
    expect(code).toMatch(/<BaseLayout\s/);
    expect(code).toContain("setPublicPageCsp(Astro)");
    expect(code).toContain("markPrivate(Astro)");
  });

  it("still wraps BOTH the #check-email success branch and the error+form branch inside the shared chrome", () => {
    expect(rawSource).toContain('id="check-email"');
    expect(code).toMatch(/result === ["']created["']/);
  });

  it("still carries the turnstileToken input in the form branch", () => {
    expect(rawSource).toContain('name="turnstileToken"');
  });

  it("still forwards the real browser Origin, never a synthesized one, on the signup POST", () => {
    expect(code).toContain('Astro.request.headers.get("Origin")');
  });
});
