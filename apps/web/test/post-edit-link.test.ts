import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { initPostVisibilityView } from "../src/scripts/post-visibility-view";

/**
 * #166 — the author-only "Edit" link on a PUBLISHED post's own page.
 *
 * Before this, an author of a visible post had no Edit link anywhere: the
 * editor was reachable only for drafts/hidden posts (OwnerPostView, owner
 * rows) or by a hand-typed `/new-post?post=<id>` URL. The link ships in the
 * edge-cached anonymous render of [handle]/[slug].astro as a STATIC `hidden`
 * anchor, identical for every viewer, and the Hide island (the one that
 * already makes the author check and reveals `.owner-actions`) un-hides it.
 *
 * Two halves, same as the rest of this suite's convention (plain-Node vitest,
 * no DOM): the island is exercised BEHAVIOURALLY against a tiny fake
 * document, and the page is pinned at source level.
 */

interface FakeEl {
  hidden: boolean;
  dataset: Record<string, string>;
  removeAttribute(name: string): void;
  closest(sel: string): FakeEl | null;
}

function fakeEl(dataset: Record<string, string> = {}): FakeEl {
  return {
    hidden: true,
    dataset,
    removeAttribute(name: string) {
      if (name === "hidden") this.hidden = false;
    },
    closest() {
      return null;
    },
  };
}

interface Page {
  root: FakeEl;
  toolbar: FakeEl;
  editLink: FakeEl;
}

/** Installs the fake DOM + `/api/me` response, runs the island, lets it settle. */
async function run(me: unknown): Promise<Page> {
  const toolbar = fakeEl();
  const root = fakeEl({ postId: "p-1", postAuthorId: "author-1", handle: "ada", slug: "hello" });
  root.closest = (sel) => (sel === ".owner-actions" ? toolbar : null);
  const editLink = fakeEl();
  const appendChild = vi.fn();
  (root as unknown as { appendChild: unknown }).appendChild = appendChild;
  const byAttr: Record<string, FakeEl> = {
    "[data-post-visibility-view]": root,
    "[data-post-edit-link]": editLink,
  };
  vi.stubGlobal("document", {
    querySelector: (sel: string) => byAttr[sel] ?? null,
    createElement: () => ({ setAttribute() {}, addEventListener() {} }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      if (me instanceof Error) return Promise.reject(me);
      if (me === 500) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(me) });
    }),
  );
  initPostVisibilityView();
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  return { root, toolbar, editLink };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("post Edit link — island reveal (author-only)", () => {
  it("the author sees the Edit link, and the toolbar is revealed with it", async () => {
    const p = await run({ userId: "author-1", csrfToken: "tok" });
    expect(p.editLink.hidden).toBe(false);
    expect(p.toolbar.hidden).toBe(false);
  });

  it("a signed-in stranger sees nothing", async () => {
    const p = await run({ userId: "someone-else", csrfToken: "tok" });
    expect(p.editLink.hidden).toBe(true);
    expect(p.root.hidden).toBe(true);
    expect(p.toolbar.hidden).toBe(true);
  });

  it("a signed-out viewer sees nothing", async () => {
    const p = await run({ userId: null, csrfToken: null });
    expect(p.editLink.hidden).toBe(true);
    expect(p.toolbar.hidden).toBe(true);
  });

  it("a degraded /api/me (author id but no CSRF token) leaves it hidden", async () => {
    const p = await run({ userId: "author-1", csrfToken: null });
    expect(p.editLink.hidden).toBe(true);
    expect(p.toolbar.hidden).toBe(true);
  });

  it("a failing /api/me (HTTP 500) leaves it hidden", async () => {
    const p = await run(500);
    expect(p.editLink.hidden).toBe(true);
  });

  it("a network error on /api/me leaves it hidden", async () => {
    const p = await run(new Error("offline"));
    expect(p.editLink.hidden).toBe(true);
  });

  it("a page without the link placeholder does not throw for the author", async () => {
    const p = await run({ userId: "author-1", csrfToken: "tok" });
    expect(p.root.hidden).toBe(false); // positive control: island ran
    vi.stubGlobal("document", {
      querySelector: (sel: string) => (sel === "[data-post-visibility-view]" ? p.root : null),
      createElement: () => ({ setAttribute() {}, addEventListener() {} }),
    });
    expect(() => initPostVisibilityView()).not.toThrow();
  });
});

describe("[handle]/[slug].astro — the static hidden Edit anchor", () => {
  const page = readFileSync(join(__dirname, "..", "src", "pages", "[handle]", "[slug].astro"), "utf8");
  const start = page.indexOf('<div class="owner-actions"');
  const end = page.indexOf("THE REPORT CONTROL", start);
  const toolbar = page.slice(start, end);
  const anchor = /<a\b[^>]*data-post-edit-link[^>]*>/.exec(toolbar)?.[0] ?? "";

  it("the anchor sits INSIDE the .owner-actions toolbar", () => {
    expect(start).toBeGreaterThan(-1);
    expect(anchor).not.toBe("");
  });

  it("is SSR-hidden and points at /new-post?post=<encodeURIComponent(post.id)>", () => {
    expect(anchor).toMatch(/\bhidden\b/);
    expect(anchor).toContain("href={`/new-post?post=${encodeURIComponent(post.id)}`}");
  });

  it("carries no viewer-specific value — only the post id, already in the page", () => {
    expect(anchor).not.toMatch(/viewer|userId|csrf|Astro\.(locals|cookies|request)/i);
  });

  it("the cached render's cache posture is untouched: still exactly markPublicCacheable, no cookie read added", () => {
    expect(page).toContain("markPublicCacheable(Astro,");
    expect(page).not.toContain("markPrivate(");
  });
});

describe("post-visibility-view.ts — the Edit reveal lives with the existing owner check", () => {
  const island = readFileSync(join(__dirname, "..", "src", "scripts", "post-visibility-view.ts"), "utf8");
  it("reveals [data-post-edit-link] after the owner gate, never before it", () => {
    const gateAt = island.indexOf("m.userId !== authorId");
    const editAt = island.indexOf("[data-post-edit-link]");
    expect(gateAt).toBeGreaterThan(-1);
    expect(editAt).toBeGreaterThan(gateAt);
  });
});
