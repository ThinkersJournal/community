import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Hide/unhide (#61 follow-up / #73) — the web-side pieces:
 *   - src/pages/api/post-hide.ts / post-unhide.ts — near-exact clones of
 *     post-delete.ts's proxy shape (POST /posts/:id/hide|unhide, markPrivate).
 *   - src/pages/api/media-restricted.ts — a RAW (non-apiFetch) proxy to the
 *     api's GET /media/restricted/:sha256, streaming binary image bytes.
 *   - src/scripts/post-visibility.ts — the editor's hide/unhide island.
 *   - src/pages/new-post.astro — wires the control + the preview image rewrite.
 *
 * Source-level pins, matching post-delete.test.ts's convention (this app's
 * vitest is plain Node; these files import `cloudflare:workers`, which does
 * not resolve outside workerd).
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const HIDE_PROXY = join(__dirname, "..", "src", "pages", "api", "post-hide.ts");
const UNHIDE_PROXY = join(__dirname, "..", "src", "pages", "api", "post-unhide.ts");
const MEDIA_PROXY = join(__dirname, "..", "src", "pages", "api", "media-restricted.ts");
const ISLAND = join(__dirname, "..", "src", "scripts", "post-visibility.ts");
const PAGE = join(__dirname, "..", "src", "pages", "new-post.astro");

const hideProxy = stripComments(readFileSync(HIDE_PROXY, "utf8"));
const unhideProxy = stripComments(readFileSync(UNHIDE_PROXY, "utf8"));
const mediaProxy = stripComments(readFileSync(MEDIA_PROXY, "utf8"));
const island = stripComments(readFileSync(ISLAND, "utf8"));
const rawPage = readFileSync(PAGE, "utf8");
const page = stripComments(rawPage);

describe("POST /api/post-hide proxy", () => {
  it("is markPrivate and forwards cookie+origin+csrf to POST /posts/<id>/hide", () => {
    expect(hideProxy).toContain("markPrivate(");
    expect(hideProxy).toMatch(/method:\s*"POST"/);
    expect(hideProxy).toContain("/hide");
    expect(hideProxy).toContain("request: context.request");
    expect(hideProxy).toContain('context.request.headers.get("Origin")');
    expect(hideProxy).toContain('context.request.headers.get("X-CSRF-Token")');
    expect(hideProxy).toContain("applyCookies(");
  });

  it("reads { postId } from the body and rejects a non-string id", () => {
    expect(hideProxy).toContain("postId");
    expect(hideProxy).toMatch(/typeof postId !== "string"/);
  });
});

describe("POST /api/post-unhide proxy", () => {
  it("is markPrivate and forwards cookie+origin+csrf to POST /posts/<id>/unhide", () => {
    expect(unhideProxy).toContain("markPrivate(");
    expect(unhideProxy).toMatch(/method:\s*"POST"/);
    expect(unhideProxy).toContain("/unhide");
    expect(unhideProxy).toContain("request: context.request");
    expect(unhideProxy).toContain('context.request.headers.get("Origin")');
    expect(unhideProxy).toContain('context.request.headers.get("X-CSRF-Token")');
    expect(unhideProxy).toContain("applyCookies(");
  });

  it("is a plain pass-through of the api's status/body — no bespoke authorization logic here", () => {
    expect(unhideProxy).toContain("response.status");
    expect(unhideProxy).toContain("response.text");
  });
});

describe("GET /api/media-restricted proxy", () => {
  it("⚠️ NEVER uses apiFetch — binary bytes would be corrupted by its text()+JSON.parse path", () => {
    expect(mediaProxy).not.toContain("apiFetch");
  });

  it("uses the raw Service Binding (env.API.fetch) instead", () => {
    expect(mediaProxy).toContain("env.API.fetch");
    expect(mediaProxy).toContain('from "cloudflare:workers"');
  });

  it("is markPrivate", () => {
    expect(mediaProxy).toContain("markPrivate(");
  });

  it("validates sha256 shape and requires postId before ever calling upstream", () => {
    expect(mediaProxy).toMatch(/\^\[0-9a-f\]\{64\}\$/);
    expect(mediaProxy).toMatch(/postId === ""/);
  });

  it("forwards ONLY the Cookie header, not credentials it shouldn't have", () => {
    expect(mediaProxy).toContain('context.request.headers.get("Cookie")');
  });

  it("targets the api's ordinary (non-legal-hold) tier: subject=post&subjectId=", () => {
    expect(mediaProxy).toContain("/media/restricted/");
    expect(mediaProxy).toContain("subject=post");
    expect(mediaProxy).toContain("subjectId=");
  });

  it("streams the upstream body through rather than buffering it", () => {
    expect(mediaProxy).toMatch(/new Response\(upstream\.body/);
  });

  it("propagates a non-ok upstream status rather than papering over it with 200", () => {
    expect(mediaProxy).toMatch(/!upstream\.ok/);
    expect(mediaProxy).toContain("status: upstream.status");
  });
});

describe("post-visibility island", () => {
  it("needs NO owner-detection dance (unlike post-delete's island) — the editor is already per-viewer SSR", () => {
    expect(island).not.toContain('fetch("/api/me")');
  });

  it("reads postId + csrfToken off the control's data attributes", () => {
    expect(island).toMatch(/data-post-visibility/);
    expect(island).toMatch(/dataset\.postId/);
    expect(island).toMatch(/dataset\.csrfToken/);
  });

  it("posts to /api/post-hide and /api/post-unhide with the CSRF header and the postId body", () => {
    expect(island).toContain("/api/post-hide");
    expect(island).toContain("/api/post-unhide");
    expect(island).toContain('"X-CSRF-Token"');
    expect(island).toMatch(/JSON\.stringify\(\{\s*postId\s*\}\)/);
  });

  it("reloads the page on success rather than hand-updating DOM state", () => {
    expect(island).toContain("location.reload()");
  });

  it("surfaces POST_UNDER_MODERATION with its own message, distinct from a generic failure", () => {
    expect(island).toContain("POST_UNDER_MODERATION");
  });

  it("exports initPostVisibility", () => {
    expect(island).toContain("export function initPostVisibility");
  });
});

describe("new-post.astro wires the hide/unhide control", () => {
  it("renders a visibility control carrying the post id and CSRF token", () => {
    expect(page).toContain("data-post-visibility");
    expect(page).toContain("data-post-id={postId}");
    expect(page).toContain("data-csrf-token={csrfToken}");
  });

  it("shows exactly one of Hide/Unhide at a time, driven by hiddenAt", () => {
    expect(page).toMatch(/data-hide-btn[^}]*hidden=\{hiddenAt !== null\}/);
    expect(page).toMatch(/data-unhide-btn[^}]*hidden=\{hiddenAt === null\}/);
  });

  it("guards every hidden descendant against the .btn display:inline-block override (post-delete/nav-bell fix pattern)", () => {
    expect(page).toMatch(/\.visibility-zone\s+\[hidden\]\s*\{\s*display:\s*none/);
  });

  it("mounts initPostVisibility() alongside the other page islands", () => {
    expect(page).toContain('import { initPostVisibility } from "../scripts/post-visibility"');
    expect(page).toContain("initPostVisibility();");
  });

  it("only renders the control in EDIT mode (postId !== null), never for a brand-new post", () => {
    expect(page).toMatch(/postId !== null[\s\S]{0,400}data-post-visibility/);
  });

  it("imports the restricted-media rewrite and applies it ONLY after hiddenAt is final, never inside the preview branch", () => {
    expect(page).toContain('import { toRestrictedMediaUrls } from "../lib/restricted-media"');
    // The call must appear AFTER the second (POST-path) hiddenAt assignment,
    // not inside the `intent === "preview"` branch, where hiddenAt for a
    // freshly-hidden post is not yet known — see the frontmatter's own
    // warning comment at that call site.
    const hiddenAtReload = page.indexOf("hiddenAt = current.data.hiddenAt");
    const rewriteCall = page.indexOf("toRestrictedMediaUrls(previewHtml, postId)");
    expect(hiddenAtReload).toBeGreaterThan(0);
    expect(rewriteCall).toBeGreaterThan(hiddenAtReload);
  });

  it("only rewrites when the post is actually hidden — a visible post's preview images stay on the public CDN", () => {
    expect(page).toMatch(/previewHtml !== null && hiddenAt !== null && postId !== null/);
  });
});
