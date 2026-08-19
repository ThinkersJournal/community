import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The signed-in nav items (New post / @handle / Sign out) are inserted
 * CLIENT-SIDE by scripts/nav-auth.ts (`document.createElement`), so they carry
 * NO astro-scope marker. A component-scoped selector (`.auth .signout`) compiles
 * to `.auth[data-astro-cid-…] .signout[data-astro-cid-…]` and never matches them
 * — leaving a bare created <button> to fall back to the UA grey box, and
 * `.support` to lose its green. The fix is `:global()` UNDER the scoped `.auth`,
 * which keeps the rules owned by this nav yet lets them reach the dynamic
 * children.
 *
 * These pins exist because that failure is SILENT — it typechecks, every other
 * test passes, and it is invisible in local dev without logging in. A future
 * "simplification" that dropped the `:global()` would re-scope the selectors and
 * quietly bring the grey box back.
 */
const NAV = readFileSync(join(__dirname, "..", "src", "components", "Nav.astro"), "utf8");

describe("Nav.astro — client-created auth items must be styled via :global()", () => {
  it("styles .signout, .support and the plain link via :global under .auth", () => {
    // If any of these are re-scoped (the `:global()` dropped), the string
    // disappears and this fails — which is the whole point: the compiled
    // scoped selector would silently stop matching the created elements.
    expect(NAV).toContain(".auth :global(.signout)");
    expect(NAV).toContain(".auth :global(.support)");
    expect(NAV).toContain(".auth :global(a)");
  });
});
