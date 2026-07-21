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
 *
 * ⚠️ MILESTONE-REVIEW FIX — CONTENT LOSS. The USERNAME_REQUIRED backstop
 * above is reached only if a not-yet-onboarded author somehow POSTs to this
 * page directly; the actual fix is upstream of that — GATE AT EDITOR-OPEN.
 * A not-onboarded author never sees the editor `<form>` at all (so there is
 * nothing typed to lose): the page fetches `GET /profile/me` and, when
 * `usernameChosen === false`, renders a "choose your handle" prompt instead
 * of the form. Both paths carry `?next=/new-post` so choose-username.astro
 * sends the author back to the editor once onboarded, rather than always to
 * /feed.
 */
const PAGE = join(import.meta.dirname, "../src/pages/new-post.astro");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const rawSource = readFileSync(PAGE, "utf8");
const code = stripComments(rawSource);

describe("new-post.astro onboarding gate", () => {
  it("branches on the api's USERNAME_REQUIRED error code", () => {
    expect(code).toContain("USERNAME_REQUIRED");
    expect(code).toMatch(/apiErrorCode\(response\)\s*===\s*["']USERNAME_REQUIRED["']/);
  });

  it("redirects to /choose-username?next=/new-post, built like every other redirect in this file (not Astro.redirect)", () => {
    // Positive first (anti-vacuity): prove the real redirect-building idiom
    // is present at all before asserting it is what USERNAME_REQUIRED uses.
    expect(code).toMatch(/new Response\(null,\s*\{\s*status:\s*302/);
    expect(code).toMatch(/Location:\s*["']\/choose-username\?next=\/new-post["']/);
    expect(code).not.toMatch(/Astro\.redirect\(/);
  });

  it("applies cookies onto the /choose-username redirect too, consistent with every other response this handler returns", () => {
    const block = code.match(/Location:\s*["']\/choose-username\?next=\/new-post["'][\s\S]{0,160}/)?.[0] ?? "";
    expect(block).toContain("applyCookies(redirect.headers, response.setCookies)");
  });
});

describe("⚠️ milestone fix: gate at editor-open so a not-onboarded author never sees the form", () => {
  it("fetches GET /profile/me and imports the Me type, alongside the existing csrf fetch", () => {
    expect(code).toMatch(/apiFetch<Me>\(\s*["']\/profile\/me["']/);
    expect(code).toContain('import type { AuthoredPost, Me } from "@thinkersjournal/shared"');
  });

  it("branches on usernameChosen === false to decide 'not onboarded'", () => {
    expect(code).toMatch(/usernameChosen\s*===\s*false/);
  });

  it("renders a choose-your-handle prompt — linking to /choose-username?next=/new-post — INSTEAD of the form for a not-onboarded author", () => {
    expect(rawSource).toContain('id="onboarding-required"');
    expect(rawSource).toContain('href="/choose-username?next=/new-post"');
  });

  it("the not-onboarded branch is checked before the editor <form> is reached, mirroring the logged-out (csrfToken === null) branch", () => {
    // Same pattern as the pre-existing logged-out gate: a ternary that picks
    // between a prompt and the real <form>, never rendering both.
    expect(code).toMatch(/notOnboarded\s*\?\s*\(/);
  });
});
