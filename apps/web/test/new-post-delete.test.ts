import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * EDITOR DELETE — Task 3 of content-deletion + media-reclamation.
 *
 * ⚠️ SOURCE/STRUCTURE TEST, NOT A RENDER — same reasoning as
 * test/new-post-page.test.ts: this app's vitest is plain Node, and the page
 * imports `cloudflare:workers` (via src/lib/api.ts), which does not resolve
 * outside workerd. The page's runtime behaviour is exercised by the E2E spine
 * and hand-testing, captured in the task report.
 *
 * The editor is already owner-only + per-viewer (edit mode loads the
 * caller's OWN draft/post — see "editing an existing post" in
 * new-post-page.test.ts, which pins the 404-on-not-mine behaviour), so this
 * control needs NO client island and no ownership check of its own: it just
 * needs a dialog-free two-step confirm and a server-side DELETE forward,
 * mirroring the page's existing save/publish idiom — same apiFetch, same
 * CSRF hidden input, same build-the-redirect-by-hand + applyCookies rule the
 * publish/draft redirects already use (see new-post-page.test.ts's
 * "Set-Cookie propagation" block for why `Astro.redirect()` is banned here).
 *
 * ⚠️ ANTI-VACUITY: every negative below is preceded by a positive that proves
 * we are looking at the real construct.
 */

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const PAGE = join(import.meta.dirname, "../src/pages/new-post.astro");
const rawSource = readFileSync(PAGE, "utf8");
const code = stripComments(rawSource);

describe("editor delete control — inline confirm, no browser dialog", () => {
  it("renders a Delete control", () => {
    expect(rawSource).toMatch(/Delete/);
  });

  it("⚠️ NO browser confirm() anywhere on the page — dialog-free two-step reveal only", () => {
    expect(code).not.toContain("confirm(");
  });

  it("uses a <details>/<summary> disclosure for the two-step reveal — no client JS dialog", () => {
    expect(rawSource).toMatch(/<details[^>]*>/);
    expect(rawSource).toMatch(/<summary[^>]*>[\s\S]{0,80}Delete/);
  });

  it("only renders the delete control in EDIT mode (postId !== null), never for a brand-new post", () => {
    expect(code).toMatch(/postId !== null[\s\S]{0,300}<details/);
  });

  it('the confirm control is a SEPARATE <form method="POST"> — HTML forbids nested forms', () => {
    const formOpenTags = rawSource.match(/<form method="POST"[^>]*>/g) ?? [];
    // the main editor-form, plus this one.
    expect(formOpenTags.length).toBeGreaterThanOrEqual(2);
  });

  it("carries a hidden intent=delete field and the post id", () => {
    expect(rawSource).toMatch(/name="intent"\s+value="delete"/);
    expect(rawSource).toMatch(/name="postId"\s+value=\{postId\}/);
  });

  it("carries the page's own CSRF hidden input, same token as the save/publish form", () => {
    expect(rawSource).toMatch(/name="csrfToken"\s+value=\{csrfToken\}/);
  });

  it("the reveal-then-confirm text makes the two-step nature explicit", () => {
    expect(rawSource).toMatch(/Really delete/i);
  });
});

describe("server-side delete branch", () => {
  it('branches on intent === "delete", distinct from preview/draft/publish', () => {
    expect(code).toMatch(/intent === ["']delete["']/);
  });

  it("forwards to DELETE /posts/<id> via apiFetch, with the SAME origin/csrfToken idiom as save/publish", () => {
    expect(code).toMatch(/apiFetch[^;]*`\/posts\/\$\{encodeURIComponent\(postId\)\}`/s);
    expect(code).toMatch(/method:\s*"DELETE"/);
    expect(code).toContain("request: Astro.request");
    expect(code).toContain("origin,");
    expect(code).toContain("csrfToken: submittedToken");
  });

  it("on 200, redirects to the author's own profile — percent-encoded, built by hand (not Astro.redirect)", () => {
    expect(code).toMatch(/response\.status === 200/);
    expect(code).toMatch(/Location:\s*`\/@\$\{encodeURIComponent\(response\.data\.username\)\}`/);
    expect(code).not.toMatch(/Astro\.redirect\(/);
  });

  it("applies Set-Cookie on the delete redirect, same rule as the publish/draft redirects above it", () => {
    const redirectBuilds = code.match(/new Response\(null,\s*\{\s*status:\s*302/g) ?? [];
    // publish redirect + draft-save redirect + this delete redirect.
    expect(redirectBuilds.length).toBeGreaterThanOrEqual(3);
    const applyOnRedirect = code.match(/applyCookies\(redirect\.headers, response\.setCookies\)/g) ?? [];
    expect(applyOnRedirect.length).toBeGreaterThanOrEqual(3);
  });

  it("surfaces a non-200 delete as the page's existing inline error state, not a thrown/unhandled response", () => {
    expect(code).toMatch(/outcome = "error"/);
  });
});
