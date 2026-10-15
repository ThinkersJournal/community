import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * MINIMAL STRUCTURE TEST — src/pages/login.astro (Task 10 theming retrofit).
 *
 * ⚠️ SOURCE/STRUCTURE TEST, NOT A RENDER — this app's vitest is plain Node,
 * and the page imports `cloudflare:workers` (via src/lib/api.ts), which does
 * not resolve outside workerd.
 *
 * This file exists ONLY to pin the theming retrofit (BaseLayout + CSP) without
 * disturbing the page's own logic, which stays proven elsewhere (the manual
 * 302 + applyCookies is exhaustively commented in the page itself, and the
 * live flow is proven by e2e/signup.spec.ts and e2e/resend-verification.spec.ts,
 * both of which log in through this exact page).
 */

const PAGE = join(import.meta.dirname, "../src/pages/login.astro");
const rawSource = readFileSync(PAGE, "utf8");

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

/**
 * The Turnstile challenge after repeated failures
 * (docs/superpowers/specs/2026-10-11-login-turnstile-challenge-design.md §6).
 *
 * ⚠️ STILL A SOURCE TEST, so what it pins is the page's STRUCTURE: the GET stays
 * on the tight CSP and renders no widget, and only the response to a POST the api
 * answered CHALLENGE_REQUIRED widens the CSP and renders the widget. Each
 * "absent from the GET" assertion is paired with the same string found in the
 * challenge branch, so a rename cannot make it vacuous.
 */
describe("login.astro: the challenge", () => {
  /** The frontmatter, up to the closing `---` of the script block. */
  const [, frontmatter = "", ...templateParts] = rawSource.split(/^---\r?$/m);
  const template = templateParts.join("---");

  it("the GET keeps the tight CSP: one unconditional default call, and the one widened call is applied only under `view.challenged`", () => {
    // The DECISION is behaviour-tested in test/login-challenge.test.ts; what is
    // pinned here is only that the page applies it and nothing else.
    expect(code).toContain("setPublicPageCsp(Astro);");
    const widened = "setPublicPageCsp(Astro, { turnstile: true })";
    expect(code.split(widened)).toHaveLength(2); // exactly one call
    const guard = code.indexOf("if (view.challenged) {");
    expect(guard, "the page never branches on view.challenged").toBeGreaterThan(-1);
    expect(code.indexOf(widened)).toBeGreaterThan(guard);
    expect(code.indexOf(widened)).toBeLessThan(code.indexOf("}", code.indexOf("prefillEmail = view.prefillEmail")));
  });

  it("forwards the widget's token to the api only when the browser sent one (a null would fail the api's schema)", () => {
    expect(code).toContain('form.get("turnstileToken")');
    expect(code).toMatch(/turnstileToken/);
    expect(frontmatter).toContain('...(typeof turnstileToken === "string" && turnstileToken !== ""');
  });

  it("hands the api's error CODE (never the status alone) and whether a token was sent to the tested decision", () => {
    expect(code).toContain("loginFailureView({");
    expect(code).toContain("code: apiErrorCode(response)");
    expect(code).toContain('sentToken: typeof turnstileToken === "string" && turnstileToken !== ""');
  });

  it("renders the signup widget markup, error/retry handling included, only in the challenge render", () => {
    expect(rawSource).toContain('class="cf-turnstile"');
    expect(rawSource).toContain("data-sitekey={turnstileSiteKey}");
    expect(rawSource).toContain('data-response-field-name="turnstileToken"');
    expect(rawSource).toContain('data-error-callback="turnstileOnError"');
    expect(rawSource).toContain('data-timeout-callback="turnstileOnTimeout"');
    expect(rawSource).toContain("data-turnstile-error");
    expect(rawSource).toContain("data-turnstile-retry");
    expect(rawSource).toContain("challenges.cloudflare.com/turnstile/v0/api.js");
    expect(code).toContain('import { initTurnstileErrorHandling } from "../scripts/turnstile-error"');
    expect(code).toContain("initTurnstileErrorHandling();");
    // Every one of them lives under the `challenged` gate: a GET has none.
    const gate = template.indexOf("challenged &&");
    expect(gate, "no `challenged &&` gate in the template").toBeGreaterThan(-1);
    expect(template.indexOf('class="cf-turnstile"')).toBeGreaterThan(gate);
    expect(template.indexOf("challenges.cloudflare.com/turnstile/v0/api.js")).toBeGreaterThan(gate);
  });

  it("keeps the visible dev/e2e dummy-token fallback behind the same build-time `turnstileSiteKey ?` ternary", () => {
    expect(code).toContain("import.meta.env.PUBLIC_TURNSTILE_SITE_KEY");
    expect(rawSource).toContain('name="turnstileToken" value="dummy-token"');
    expect(code).toMatch(/turnstileSiteKey \?/);
    expect(rawSource).toMatch(/type="text" name="turnstileToken" value="dummy-token"/);
  });

  it("prefills the (Astro-escaped) email, never echoes the password, and focuses the password field on the challenge render", () => {
    expect(template).toMatch(/name="email"[^>]*value=\{/);
    expect(template).not.toMatch(/name="password"[^>]*value=/);
    expect(template).toMatch(/name="password"[^>]*autofocus=\{challenged\}/);
    // No raw HTML sink for the echoed address.
    expect(rawSource).not.toContain("set:html");
  });

  it("announces the message in the existing role=alert #error", () => {
    expect(rawSource).toContain('id="error" role="alert"');
    expect(code).toContain("error = view.error;");
  });
});
