import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #70 — src/pages/forgot-password.astro.
 *
 * ⚠️ SOURCE/STRUCTURE TEST, NOT A RENDER — this app's vitest is plain Node,
 * and the page imports `cloudflare:workers` (via src/lib/api.ts), which does
 * not resolve outside workerd. The live flow is proven end to end at the api
 * layer in apps/api/test/forgot-password.test.ts.
 */

const PAGE = join(import.meta.dirname, "../src/pages/forgot-password.astro");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(readFileSync(PAGE, "utf8"));

describe("forgot-password.astro", () => {
  it("adopts the shared chrome + Turnstile-widened CSP while staying markPrivate", () => {
    expect(code).toMatch(/<BaseLayout\s/);
    expect(code).toContain("setPublicPageCsp(Astro, { turnstile: true })");
    expect(code).toContain("markPrivate(Astro)");
    expect(code).not.toContain("markPublicCacheable(");
  });

  it("still forwards the real browser Origin, never a synthesized one", () => {
    expect(code).toContain('Astro.request.headers.get("Origin")');
  });

  it("⚠️ never branches its copy on WHETHER the api found the email — only on status/network shape", () => {
    // The whole enumeration defense (apps/api/src/routes/forgot-password.ts)
    // is undone if this page shows a different message for "found" vs
    // "not found". The api answers 202 either way; this asserts the page's
    // only success branch is that one status, with no secondary condition.
    expect(code).toMatch(/response\.status === 202/);
    expect(code).not.toMatch(/EMAIL_NOT_FOUND|USER_NOT_FOUND|NOT_REGISTERED/);
  });

  it("carries no plaintext password field — this is the request step, not the redeem step", () => {
    expect(code).not.toMatch(/type="password"/);
  });

  it("renders the Turnstile widget in prod, the dev/e2e dummy-token fallback otherwise — same idiom as signup.astro", () => {
    expect(code).toContain("data-response-field-name=\"turnstileToken\"");
    expect(code).toContain('name="turnstileToken" value="dummy-token"');
  });

  it("links to /login", () => {
    expect(code).toMatch(/href="\/login"/);
  });

  // ⚠️ 2026-09-24 — same failure-UX fix as signup.astro (see
  // src/scripts/turnstile-error.ts's header): a failed/timed-out challenge
  // used to leave the visitor on "Verifying…" forever with no feedback.
  it("wires the real widget's error/timeout callbacks to the shared failure-UX island, co-located with the widget branch", () => {
    const ternaryStart = code.indexOf("turnstileSiteKey ? (");
    const widgetBranch = code.slice(ternaryStart, code.indexOf(") : (", ternaryStart));
    expect(widgetBranch).toContain('data-error-callback="turnstileOnError"');
    expect(widgetBranch).toContain('data-timeout-callback="turnstileOnTimeout"');
    expect(widgetBranch).toContain("data-turnstile-error");
    expect(widgetBranch).toContain("data-turnstile-retry");
    expect(code).toContain('import { initTurnstileErrorHandling } from "../scripts/turnstile-error"');
    expect(code).toContain("initTurnstileErrorHandling();");
  });

  it("the retry affordance shows explanatory copy, not a bare button with no context", () => {
    expect(code).toMatch(/Verification failed/);
    expect(code).toMatch(/Tap to retry/);
  });
});
