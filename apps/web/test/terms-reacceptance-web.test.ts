// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ROADMAP R12, web side. Source/structure tests, as the other pages' (the pages import
 * `cloudflare:workers` through lib/api.ts, which plain-Node vitest cannot resolve).
 */
const SRC = join(import.meta.dirname, "../src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("/api/terms-status", () => {
  const src = strip(read("pages/api/terms-status.ts"));
  it("is a never-cached GET proxy of the api's /account/terms that forwards the cookie", () => {
    expect(src).toMatch(/export const GET\s*:\s*APIRoute/);
    expect(src).toContain("export const prerender = false");
    expect(src).toMatch(/markPrivate\(/);
    expect(src).toContain("/account/terms");
    expect(src).toMatch(/request:\s*context\.request/);
  });
  it("answers only a boolean: anything but a clean 200 is 'no notice'", () => {
    expect(src).toContain("needsAcceptance");
    expect(src).toMatch(/res\.status === 200/);
  });
});

describe("the nav island", () => {
  it("asks /api/terms-status after sign-in and links to /settings/terms only when acceptance is needed", () => {
    const s = read("scripts/nav-auth.ts");
    expect(s).toContain("/api/terms-status");
    expect(s).toContain('terms.href = "/settings/terms"');
    expect(s).toMatch(/needsAcceptance !== true/);
  });
});

describe("/settings/terms", () => {
  const raw = read("pages/settings/terms.astro");
  const code = strip(raw);
  it("is private and CSP-wrapped like the other settings pages", () => {
    expect(code).toContain("markPrivate(Astro)");
    expect(code).toContain("setPublicPageCsp(Astro)");
    expect(code).toContain("loginHrefFor");
  });
  it("posts both boxes as booleans to /account/terms with the forwarded Origin and CSRF token", () => {
    expect(code).toContain('"/account/terms"');
    expect(code).toContain('acceptedTerms: form.get("acceptedTerms") === "on"');
    expect(code).toContain('confirmedAge: form.get("confirmedAge") === "on"');
    expect(code).toContain('Astro.request.headers.get("Origin")');
    expect(code).toContain("csrfToken");
  });
  it("shows the form only when acceptance is needed, and requires both boxes", () => {
    expect(raw).toContain("info.needsAcceptance");
    expect(raw).toContain('name="acceptedTerms" required');
    expect(raw).toContain('name="confirmedAge" required');
    expect(raw).toContain("at least 16");
  });
});
