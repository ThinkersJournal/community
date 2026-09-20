import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE `.btn` + `[hidden]` CSS-ORIGIN BUG, FIXED ONCE, GLOBALLY.
 *
 * `.btn{display:inline-block}` (this file) is AUTHOR-origin, so it beats the
 * UA sheet's `[hidden]{display:none}` regardless of selector specificity — CSS
 * resolves origin before specificity. Any element that is both `class="btn ..."`
 * and carries the `hidden` attribute stays visibly on-screen and (worse)
 * clickable. PM root-caused this as a CLASS of bug (not a one-off): the follow
 * button on `[handle]/index.astro` shipped with no local guard, stayed
 * visible, and its listener still fired a self-follow the server had to
 * refuse — while post-delete.ts and post-visibility-view.ts had each
 * independently hit and locally patched the identical defeat before this rule
 * existed.
 *
 * This is a plain-Node source check, matching this app's other CSS-cascade
 * pins (page-cache-inventory.test.ts, post-visibility-view.test.ts) — there is
 * no DOM/cascade engine in this test environment (see those files' headers).
 */

const GLOBAL_CSS = join(import.meta.dirname, "../src/styles/global.css");
const FOLLOW_BUTTON_PAGE = join(import.meta.dirname, "../src/pages/[handle]/index.astro");

const css = readFileSync(GLOBAL_CSS, "utf8");

describe("global.css — .btn[hidden] guard", () => {
  it("positive: .btn is declared inline-block (the property the guard must override)", () => {
    expect(css).toMatch(/\.btn\s*\{[^}]*display:\s*inline-block/);
  });

  it("⚠️ .btn[hidden]{display:none} exists — (0,2,0) beats .btn's (0,1,0) within the same (author) origin", () => {
    expect(css).toMatch(/\.btn\[hidden\]\s*\{\s*display:\s*none/);
  });
});

describe("[handle]/index.astro — the follow button that surfaced this bug", () => {
  it("is a .btn carrying hidden — the exact shape the global guard above must cover", () => {
    const page = readFileSync(FOLLOW_BUTTON_PAGE, "utf8");
    expect(page).toMatch(/class="btn btn-primary follow"[^>]*\bhidden\b/);
  });
});
