import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * handle-at-signup Task 4: the editor's onboarding gate is GONE. A handle is
 * chosen once, at signup (apps/api/src/routes/signup.ts) — there is no more
 * post-signup "choose a handle" step, so new-post.astro no longer fetches
 * `GET /profile/me` to decide whether to show the form, no longer branches on
 * the api's (now-removed) `USERNAME_REQUIRED` code, and no longer redirects to
 * `/choose-username`. This file used to pin that gate; it now pins its
 * absence, so a regression that reintroduces it fails loudly here.
 */
const PAGE = join(import.meta.dirname, "../src/pages/new-post.astro");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const rawSource = readFileSync(PAGE, "utf8");
const code = stripComments(rawSource);

describe("new-post.astro has no onboarding gate", () => {
  it("never branches on USERNAME_REQUIRED (the api no longer emits that code)", () => {
    expect(code).not.toContain("USERNAME_REQUIRED");
  });

  it("never redirects to /choose-username", () => {
    expect(code).not.toContain("/choose-username");
  });

  it("does not fetch GET /profile/me or import the shared Me type — signed-in and verified is the whole gate now", () => {
    expect(code).not.toMatch(/apiFetch<Me>\(\s*["']\/profile\/me["']/);
    expect(code).not.toContain('import type { AuthoredPost, Me } from "@thinkersjournal/shared"');
  });

  it("shows the editor <form> to any signed-in user (csrfToken !== null), with no onboarding branch in between", () => {
    expect(rawSource).not.toContain('id="onboarding-required"');
    expect(code).not.toMatch(/notOnboarded/);
    expect(code).toMatch(/csrfToken\s*===\s*null\s*\?\s*\(/);
  });
});
