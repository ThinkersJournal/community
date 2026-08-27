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
    // Opts into the Turnstile CSP addition (signup is the only page that does).
    expect(code).toContain("setPublicPageCsp(Astro, { turnstile: true })");
    expect(code).toContain("markPrivate(Astro)");
  });

  it("still wraps BOTH the #check-email success branch and the error+form branch inside the shared chrome", () => {
    expect(rawSource).toContain('id="check-email"');
    expect(code).toMatch(/result === ["']created["']/);
  });

  it("renders the real Turnstile widget wired to feed the api's `turnstileToken` field", () => {
    // The dummy placeholder `<input value="dummy-token">` is gone; the widget's
    // `data-response-field-name` injects the hidden `turnstileToken` the api reads.
    // The site key is PUBLIC by design.
    expect(rawSource).toContain('class="cf-turnstile"');
    expect(rawSource).toContain('data-sitekey="0x4AAAAAAEeHIE7gGXEOrrpY"');
    expect(rawSource).toContain('data-response-field-name="turnstileToken"');
    expect(rawSource).toContain("challenges.cloudflare.com/turnstile/v0/api.js");
    expect(rawSource).not.toContain('value="dummy-token"');
  });

  it("still forwards the real browser Origin, never a synthesized one, on the signup POST", () => {
    expect(code).toContain('Astro.request.headers.get("Origin")');
  });

  // handle-at-signup Task 7: the signup form now collects a chosen @handle
  // and surfaces the api's USERNAME_TAKEN suggestions as plain server-rendered
  // text (no client JS for the suggestions; the page's only script is Turnstile's
  // external api.js, and script-src still carries no 'unsafe-inline').
  it("has a username field with permanence copy, and forwards it to the api", () => {
    expect(rawSource).toMatch(/name="username"/);
    expect(rawSource).toMatch(/permanent/i);
    expect(code).toContain('username: form.get("username")');
  });

  it("branches on USERNAME_TAKEN and renders the returned suggestions as plain text", () => {
    expect(code).toContain("USERNAME_TAKEN");
    expect(code).toMatch(/suggestions/);
  });

  // Fix round 1: 400 has TWO causes — reserved handle (api attaches a static
  // `message`, e.g. "That handle is reserved.") vs. plain zod bad-format
  // (no `message`). Only the reserved case should surface api-supplied copy;
  // bad-format must keep the generic fallback, never show nothing meaningful.
  it("surfaces the api's message verbatim on a 400 that carries one (reserved handle), and keeps the generic fallback for a 400 that doesn't (bad format)", () => {
    expect(code).toContain("response.status === 400 && response.data?.message");
    expect(code).toContain("message = response.data.message;");
    expect(code).toContain("Signup failed. Check your email and password and try again.");
  });
});
