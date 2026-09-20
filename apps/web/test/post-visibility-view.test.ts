import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * POST-VIEW HIDE control (#74 audit finding, batch A-2) — the owner-only
 * "hide this post" affordance on the page a user actually looks at
 * ([handle]/[slug].astro), not just the editor. Batch A shipped Hide/Unhide
 * ONLY in new-post.astro, reachable exclusively by a hand-typed
 * `/new-post?post=<id>` URL — CireSnave could not find it. This is the fix.
 * ⚠️ Still HIDE-ONLY here (see this control's own header for why that's
 * structural, not a gap) — Unhide lives on the editor AND, since #78, on this
 * post's own URL via OwnerPostView.astro, which the redirect below now
 * targets instead of the editor.
 *
 * Source-level pins, matching post-delete.test.ts's convention (this app's
 * vitest is plain Node; these files import `cloudflare:workers` indirectly
 * or reference APIs that do not resolve outside workerd).
 */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const ISLAND_PATH = join(__dirname, "..", "src", "scripts", "post-visibility-view.ts");
const PAGE_PATH = join(__dirname, "..", "src", "pages", "[handle]", "[slug].astro");

const island = stripComments(readFileSync(ISLAND_PATH, "utf8"));
const page = stripComments(readFileSync(PAGE_PATH, "utf8"));

describe("post-visibility-view island", () => {
  it("reads viewer identity from /api/me", () => {
    expect(island).toContain('fetch("/api/me")');
  });

  it("reads the post's author id off the control's data attribute", () => {
    expect(island).toMatch(/data-post-visibility-view/);
    expect(island).toMatch(/dataset\.postAuthorId/);
  });

  it("reveals the control only when the viewer IS the author AND has a CSRF token", () => {
    // ⚠️ ANTI-VACUITY: co-locate the owner-match check with the reveal
    // (root.hidden = false), same pin shape as post-delete.test.ts.
    expect(island).toMatch(
      /m\.userId === null[\s\S]{0,200}m\.userId !== authorId[\s\S]{0,200}root\.hidden = false/,
    );
  });

  it("has NO Unhide affordance — structurally impossible on this page (a hidden post 404s here)", () => {
    expect(island).not.toMatch(/unhide/i);
    expect(island).not.toContain("/api/post-unhide");
  });

  it("posts to /api/post-hide with the CSRF header and the postId body", () => {
    expect(island).toContain("/api/post-hide");
    expect(island).toContain('"X-CSRF-Token"');
    expect(island).toMatch(/method:\s*"POST"/);
    expect(island).toMatch(/JSON\.stringify\(\{\s*postId\s*\}\)/);
  });

  it("reads the redirect-target handle/slug off the control's data attributes", () => {
    expect(island).toMatch(/dataset\.handle/);
    expect(island).toMatch(/dataset\.slug/);
  });

  it("⚠️ redirects back to the post's OWN URL on success (#78), not the editor", () => {
    // Before #78 this page hard-404'd for everyone including the author once
    // hidden, so the editor was the only place left to show the hidden state.
    // Since #78, [handle]/[slug].astro falls back to an owner view instead of
    // 404ing for its own author — reloading this exact URL now works.
    expect(island).toMatch(
      /location\.href\s*=\s*"\/@"\s*\+\s*encodeURIComponent\(handle\)\s*\+\s*"\/"\s*\+\s*encodeURIComponent\(slug\)/,
    );
    expect(island).not.toMatch(/\/new-post\?post=/);
  });

  it("uses createElement/textContent only — no innerHTML, no browser dialog", () => {
    expect(island).toContain("createElement");
    expect(island).not.toContain("confirm(");
    expect(island).not.toContain("innerHTML");
  });

  it("exports initPostVisibilityView", () => {
    expect(island).toContain("export function initPostVisibilityView");
  });
});

describe("[handle]/[slug].astro wires the hide control", () => {
  it("ships a hidden hide-control root carrying the post id and author id", () => {
    expect(page).toContain("data-post-visibility-view");
    expect(page).toMatch(/data-post-visibility-view[^>]*hidden|hidden[^>]*data-post-visibility-view/);
    expect(page).toContain("data-post-id={post.id}");
    expect(page).toContain("data-post-author-id={post.authorId}");
  });

  it("carries the redirect-target handle/slug (#78) — NOT the route param, which still has its @ prefix", () => {
    expect(page).toContain("data-handle={post.username}");
    expect(page).toContain("data-slug={post.slug}");
  });

  it("mounts initPostVisibilityView() alongside the other page islands", () => {
    expect(page).toContain('import { initPostVisibilityView } from "../../scripts/post-visibility-view"');
    expect(page).toContain("initPostVisibilityView();");
  });

  it("guards every hidden descendant against the .btn display:inline-block override (post-delete fix pattern)", () => {
    expect(page).toMatch(/\.post-visibility-view\s*\[hidden\]\s*\{\s*display:\s*none/);
  });
});
