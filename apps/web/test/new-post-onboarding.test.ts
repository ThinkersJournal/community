import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Task 14 — the editor's onboarding gate.
 *
 * Task 8 makes `api POST /posts` / `PATCH /posts/:id` answer a not-yet-
 * onboarded author's PUBLISH attempt with 409 `USERNAME_REQUIRED` — reached
 * only past the api's full mutating pipeline (session valid, email
 * verified; see apps/api/src/routes/posts.ts). Without this branch the
 * editor would surface that as a raw "Could not save (status 409)." error
 * instead of sending the author to pick a handle.
 *
 * ⚠️ NOT `Astro.redirect(...)`. test/new-post-page.test.ts already pins that
 * this file NEVER calls `Astro.redirect()` (login.astro's Set-Cookie-drop
 * bug: a response `Astro.redirect()` builds itself does not carry
 * `Astro.response.headers`, so a `Set-Cookie` riding on it would be
 * silently dropped). This 409 carries no `Set-Cookie` of its own — the
 * mutating pipeline already passed — but the redirect below is still built
 * the SAME way as this file's other two redirects (a hand-built
 * `new Response(null, { status: 302, ... })` + `applyCookies`), so it is
 * not a special case that could rot silently if that ever changes.
 */
const PAGE = join(import.meta.dirname, "../src/pages/new-post.astro");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const code = stripComments(readFileSync(PAGE, "utf8"));

describe("new-post.astro onboarding gate", () => {
  it("branches on the api's USERNAME_REQUIRED error code", () => {
    expect(code).toContain("USERNAME_REQUIRED");
    expect(code).toMatch(/apiErrorCode\(response\)\s*===\s*["']USERNAME_REQUIRED["']/);
  });

  it("redirects to /choose-username, built like every other redirect in this file (not Astro.redirect)", () => {
    // Positive first (anti-vacuity): prove the real redirect-building idiom
    // is present at all before asserting it is what USERNAME_REQUIRED uses.
    expect(code).toMatch(/new Response\(null,\s*\{\s*status:\s*302/);
    expect(code).toMatch(/Location:\s*["']\/choose-username["']/);
    expect(code).not.toMatch(/Astro\.redirect\(/);
  });

  it("applies cookies onto the /choose-username redirect too, consistent with every other response this handler returns", () => {
    const block = code.match(/Location:\s*["']\/choose-username["'][\s\S]{0,160}/)?.[0] ?? "";
    expect(block).toContain("applyCookies(redirect.headers, response.setCookies)");
  });
});
