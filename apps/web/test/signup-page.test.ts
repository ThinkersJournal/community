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

  it("renders the real Turnstile widget in prod builds, with a dummy-token fallback for dev/e2e", () => {
    // PROD branch: the real widget, keyed from the build-time
    // PUBLIC_TURNSTILE_SITE_KEY (a domain-locked widget can't render on
    // localhost, so it is prod-only — dev/e2e would otherwise hang signup).
    expect(code).toContain("import.meta.env.PUBLIC_TURNSTILE_SITE_KEY");
    expect(rawSource).toContain('class="cf-turnstile"');
    expect(rawSource).toContain("data-sitekey={turnstileSiteKey}");
    expect(rawSource).toContain('data-response-field-name="turnstileToken"');
    expect(rawSource).toContain("challenges.cloudflare.com/turnstile/v0/api.js");
    // DEV/E2E branch: the always-pass dummy token, so signup is exercisable on
    // localhost where the real widget can't render.
    expect(rawSource).toContain('name="turnstileToken" value="dummy-token"');
    // Both are gated on the same build-time key.
    expect(code).toMatch(/turnstileSiteKey \?/);
  });

  it("still forwards the real browser Origin, never a synthesized one, on the signup POST", () => {
    expect(code).toContain('Astro.request.headers.get("Origin")');
  });

  // handle-at-signup Task 7: the signup form now collects a chosen @handle
  // and surfaces the api's USERNAME_TAKEN suggestions as plain server-rendered
  // text (no client JS for the suggestions; the page's only script is Turnstile's
  // external api.js, and script-src still carries no 'unsafe-inline').
  // Account deletion (M4) makes a handle releasable after a 30-day grace
  // period, so "permanent" is no longer true — the copy states the actual
  // mechanic (temporary only after deletion, not temporary in general).
  it("has a username field, and forwards it to the api, with copy that doesn't overclaim permanence", () => {
    expect(rawSource).toMatch(/name="username"/);
    expect(rawSource).not.toMatch(/permanent/i);
    expect(rawSource).toMatch(/30-day grace/i);
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

  // ⚠️ 2026-09-24 — a failed/timed-out challenge used to leave the visitor on
  // "Verifying…" forever with no feedback (see src/scripts/turnstile-error.ts's
  // header). ONLY on the real-widget branch: the dummy-token fallback has no
  // widget to fail.
  it("wires the real widget's error/timeout callbacks to the shared failure-UX island, only on the real-widget branch", () => {
    expect(rawSource).toContain('data-error-callback="turnstileOnError"');
    expect(rawSource).toContain('data-timeout-callback="turnstileOnTimeout"');
    expect(rawSource).toContain("data-turnstile-error");
    expect(rawSource).toContain("data-turnstile-retry");
    expect(code).toContain('import { initTurnstileErrorHandling } from "../scripts/turnstile-error"');
    expect(code).toContain("initTurnstileErrorHandling();");
    // ⚠️ ANTI-VACUITY: the error/retry markup lives inside the SAME
    // `turnstileSiteKey ? ... : ...` ternary the widget itself is gated on
    // (see the render test above) — co-locate rather than re-assert
    // structure this file already pins elsewhere.
    const ternaryStart = rawSource.indexOf("turnstileSiteKey ? (");
    const widgetBranch = rawSource.slice(ternaryStart, rawSource.indexOf(") : (", ternaryStart));
    expect(widgetBranch).toContain("data-turnstile-error");
    expect(widgetBranch).toContain("data-turnstile-retry");
  });

  it("the retry affordance shows explanatory copy, not a bare button with no context", () => {
    expect(rawSource).toMatch(/Verification failed/);
    expect(rawSource).toMatch(/Tap to retry/);
  });
});
