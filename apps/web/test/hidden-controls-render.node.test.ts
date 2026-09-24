import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Browser, chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * RENDERED-AND-MEASURED verification of every `[hidden]{display:none}` guard
 * in this app, closing a gap the PM flagged (2026-09-24 endpoint/UI audit):
 * the audit's own bucket-1 reachability findings were CODE-TRACED (grep for
 * a matching CSS rule), not rendered. That is exactly the shape of proof
 * that missed #82 in production — the rule existed in source and was still
 * defeated at runtime by an author-origin `display` declaration earlier in
 * the cascade (`.owner-actions{display:flex}` beating `.owner-actions[hidden]`
 * on specificity is not the failure; `.btn{display:inline-block}` — a
 * DIFFERENT selector entirely — beating the UA sheet by ORIGIN, before
 * specificity is even consulted, is). A string match can confirm the rule's
 * text exists; only a real browser's computed style can confirm it *wins*.
 *
 * ⚠️ Every control here gets a NEGATIVE CONTROL: assert the SAME element,
 * `hidden` removed, computes visible. A guard that always reports "hidden"
 * regardless of the attribute would pass a hidden-only assertion while
 * proving nothing — the negative control is what makes this a test of the
 * `[hidden]` mechanism rather than a test that `display:none` can be typed
 * into a stylesheet.
 *
 * Technique: launch real Playwright chromium directly (`chromium.launch()`),
 * NOT the `playwright test` runner and NOT this repo's own `e2e/` harness —
 * no two-Worker dev server, no Postgres, no wrangler. Same shape used to
 * verify #82's ~6px margin-collapse regression against static HTML fixtures
 * before this file existed. Chromium must be installed locally
 * (`pnpm exec playwright install chromium`) or in the CI image; this suite
 * does not attempt to install it itself.
 *
 * CSS is READ from the real source files at test time (global.css in full,
 * plus each page/component's own `<style>` block via `extractStyleBlock`)
 * so a future edit to any of these rules is picked up automatically rather
 * than silently drifting from a copy-pasted snapshot. Only the MARKUP is
 * hand-written per fixture — these controls are populated by client-JS
 * islands at runtime (post-delete.ts, post-visibility-view.ts, owner-posts.ts,
 * notify-bell.ts), so there is no static real markup to read for their
 * revealed contents; each fixture below is cited against the exact island
 * code that creates the real shape (class names, hidden defaults).
 */

const WEB_SRC = join(import.meta.dirname, "..", "src");

/** The full text of the ONE real `<style>...</style>` block in `file`. */
function extractStyleBlock(file: string): string {
  const source = readFileSync(join(WEB_SRC, file), "utf8");
  const open = source.lastIndexOf("<style>");
  const close = source.indexOf("</style>", open);
  if (open === -1 || close === -1) {
    throw new Error(`no <style> block found in ${file}`);
  }
  return source.slice(open + "<style>".length, close);
}

/** global.css minus its `@import` (tokens.css isn't needed to test `display`). */
function globalCss(): string {
  return readFileSync(join(WEB_SRC, "styles", "global.css"), "utf8").replace(
    /^@import[^;]+;\s*/,
    "",
  );
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

/**
 * Renders `markup` under `css`, returns the computed `display` of every
 * selector in `selectors` — once as shipped (whatever `hidden` state the
 * markup itself carries) via `.hidden` on the query result, so callers can
 * assert both the base case AND, after toggling the attribute in-page, the
 * negative control — all in one page load (cheaper than one launch per
 * assertion, and avoids any doubt that two separate pages could differ).
 */
async function computedDisplay(
  css: string,
  markup: string,
  selector: string,
): Promise<{ asShipped: string; withHiddenRemoved: string }> {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><style>${css}</style>${markup}`);
    const asShipped = await page.locator(selector).first().evaluate(
      (el) => getComputedStyle(el).display,
    );
    await page.locator(selector).first().evaluate((el) => el.removeAttribute("hidden"));
    const withHiddenRemoved = await page.locator(selector).first().evaluate(
      (el) => getComputedStyle(el).display,
    );
    return { asShipped, withHiddenRemoved };
  } finally {
    await page.close();
  }
}

describe("global .btn[hidden] — global.css:34", () => {
  // Real shape cited in global.css's own header comment: `[handle]/index.astro`'s
  // follow button, `.btn.btn-primary.follow[hidden]`.
  it("[hidden] computes display:none, and NOT hidden computes visible (negative control)", async () => {
    const { asShipped, withHiddenRemoved } = await computedDisplay(
      globalCss(),
      `<button class="btn btn-primary follow" hidden>Follow</button>`,
      ".btn",
    );
    expect(asShipped).toBe("none");
    expect(withHiddenRemoved).not.toBe("none");
  });
});

describe("[handle]/[slug].astro — .owner-actions[hidden]", () => {
  it("[hidden] computes display:none despite the wrapper's own display:flex, and the negative control renders visible", async () => {
    const css = extractStyleBlock(join("pages", "[handle]", "[slug].astro"));
    const markup = `
      <div class="owner-actions" hidden>
        <div class="post-visibility-view" data-post-visibility-view hidden></div>
        <div class="post-delete" data-post-delete hidden></div>
      </div>`;
    const { asShipped, withHiddenRemoved } = await computedDisplay(css, markup, ".owner-actions");
    expect(asShipped).toBe("none");
    expect(withHiddenRemoved).not.toBe("none");
  });
});

describe("[handle]/[slug].astro — .post-delete[hidden] and its descendant guard", () => {
  it("the root's own [hidden] computes display:none, negative control visible", async () => {
    const css = extractStyleBlock(join("pages", "[handle]", "[slug].astro"));
    const markup = `<div class="post-delete" data-post-delete hidden></div>`;
    const { asShipped, withHiddenRemoved } = await computedDisplay(css, markup, ".post-delete");
    expect(asShipped).toBe("none");
    expect(withHiddenRemoved).not.toBe("none");
  });

  it("a hidden DESCENDANT (post-delete.ts's .post-delete-confirm, created hidden=true) is guarded too", async () => {
    // src/scripts/post-delete.ts: confirmRow.className = "post-delete-confirm";
    // confirmRow.hidden = true — created alongside the visible "start" button.
    const css = extractStyleBlock(join("pages", "[handle]", "[slug].astro"));
    const markup = `
      <div class="post-delete" data-post-delete>
        <button type="button" class="btn btn-ghost">Delete post</button>
        <span class="post-delete-confirm" hidden>
          <span>Really delete?</span>
          <button type="button" class="btn btn-primary">Confirm</button>
          <button type="button" class="btn btn-ghost">Cancel</button>
        </span>
      </div>`;
    const { asShipped, withHiddenRemoved } = await computedDisplay(
      css,
      markup,
      ".post-delete-confirm",
    );
    expect(asShipped).toBe("none");
    expect(withHiddenRemoved).not.toBe("none");
  });
});

describe("[handle]/[slug].astro — .post-visibility-view[hidden] and its descendant guard", () => {
  it("the root's own [hidden] computes display:none, negative control visible", async () => {
    const css = extractStyleBlock(join("pages", "[handle]", "[slug].astro"));
    const markup = `<div class="post-visibility-view" data-post-visibility-view hidden></div>`;
    const { asShipped, withHiddenRemoved } = await computedDisplay(
      css,
      markup,
      ".post-visibility-view",
    );
    expect(asShipped).toBe("none");
    expect(withHiddenRemoved).not.toBe("none");
  });

  it("⚠️ the descendant guard (.post-visibility-view [hidden]) is not currently exercised by real DOM (post-visibility-view.ts never sets a descendant's hidden), but is proven functional here as defense-in-depth", async () => {
    const css = extractStyleBlock(join("pages", "[handle]", "[slug].astro"));
    const markup = `
      <div class="post-visibility-view" data-post-visibility-view>
        <button type="button" class="btn btn-ghost">Hide post</button>
        <p class="post-visibility-error" hidden>Something went wrong</p>
      </div>`;
    const { asShipped, withHiddenRemoved } = await computedDisplay(
      css,
      markup,
      ".post-visibility-error",
    );
    expect(asShipped).toBe("none");
    expect(withHiddenRemoved).not.toBe("none");
  });
});

describe("new-post.astro — .visibility-zone [hidden] descendant guard", () => {
  // Real shape (new-post.astro:483-499): hide-btn / unhide-btn toggle `hidden`
  // based on hiddenAt/hiddenReason; exactly one is hidden at a time. `.btn`'s
  // own global [hidden] rule ALSO applies here — this proves the zone's
  // descendant combinator does not need it (belt-and-braces, like post-delete).
  it("a hidden hide/unhide button inside the zone computes display:none, negative control visible", async () => {
    const css = globalCss() + extractStyleBlock(join("pages", "new-post.astro"));
    const markup = `
      <div class="visibility-zone" data-post-visibility>
        <button type="button" class="btn btn-ghost" data-hide-btn hidden>Hide post</button>
        <button type="button" class="btn btn-ghost" data-unhide-btn>Unhide post</button>
      </div>`;
    const { asShipped, withHiddenRemoved } = await computedDisplay(css, markup, "[data-hide-btn]");
    expect(asShipped).toBe("none");
    expect(withHiddenRemoved).not.toBe("none");
  });
});

describe("[handle]/index.astro — .owner-posts[hidden]", () => {
  it("[hidden] computes display:none, negative control visible", async () => {
    const css = extractStyleBlock(join("pages", "[handle]", "index.astro"));
    const markup = `
      <section class="owner-posts" data-owner-posts hidden>
        <ul class="posts" data-owner-posts-list></ul>
      </section>`;
    const { asShipped, withHiddenRemoved } = await computedDisplay(css, markup, ".owner-posts");
    expect(asShipped).toBe("none");
    expect(withHiddenRemoved).not.toBe("none");
  });
});

describe("Nav.astro — .notify[hidden] and .notify-panel[hidden]", () => {
  it("the bell wrapper's [hidden] computes display:none despite display:flex, negative control visible", async () => {
    const css = extractStyleBlock("components/Nav.astro");
    const markup = `
      <span class="notify" data-notify-bell hidden>
        <button type="button" class="bell" data-notify-toggle>🔔</button>
        <div class="notify-panel" data-notify-panel hidden></div>
      </span>`;
    const { asShipped, withHiddenRemoved } = await computedDisplay(css, markup, ".notify");
    expect(asShipped).toBe("none");
    expect(withHiddenRemoved).not.toBe("none");
  });

  it("the panel's OWN [hidden] computes display:none independently of the bell wrapper, negative control visible", async () => {
    const css = extractStyleBlock("components/Nav.astro");
    const markup = `
      <span class="notify" data-notify-bell>
        <button type="button" class="bell" data-notify-toggle>🔔</button>
        <div class="notify-panel" data-notify-panel hidden></div>
      </span>`;
    const { asShipped, withHiddenRemoved } = await computedDisplay(
      css,
      markup,
      ".notify-panel",
    );
    expect(asShipped).toBe("none");
    expect(withHiddenRemoved).not.toBe("none");
  });
});
