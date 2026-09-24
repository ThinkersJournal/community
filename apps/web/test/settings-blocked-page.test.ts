import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const page = strip(
  readFileSync(join(__dirname, "..", "src", "pages", "settings", "blocked.astro"), "utf8"),
);
const island = strip(
  readFileSync(join(__dirname, "..", "src", "scripts", "blocked-list.ts"), "utf8"),
);

describe("settings/blocked.astro", () => {
  it("is authed (markPrivate), redirects to /login without a session, and reads GET /blocks", () => {
    expect(page).toContain("markPrivate(");
    expect(page).toContain('Astro.redirect("/login")');
    expect(page).toContain('apiFetch<BlockedList>("/blocks"');
  });

  it("⚠️ does NOT use define:vars — this page shares the public-page CSP (no 'unsafe-inline', no nonce), so an inline script would be silently blocked", () => {
    expect(page).not.toContain("define:vars");
  });

  it("passes the CSRF token to the bundled island via a data attribute, not inline JS", () => {
    expect(page).toContain("data-csrf-token={csrfToken}");
    expect(page).toContain('import { initBlockedList } from "../../scripts/blocked-list"');
    expect(page).toContain("initBlockedList();");
  });

  it("links to and from settings/notifications so both are reachable from one nav entry", () => {
    expect(page).toContain("/settings/notifications");
  });
});

describe("blocked-list island", () => {
  it("reads the CSRF token from the list's own data attribute, not a global", () => {
    expect(island).toContain('list.dataset.csrfToken');
  });

  it("posts to /api/unblock with the CSRF header for each row", () => {
    expect(island).toContain('fetch("/api/unblock"');
    expect(island).toMatch(/"X-CSRF-Token":\s*csrfToken/);
  });

  it("exports initBlockedList", () => {
    expect(island).toContain("export function initBlockedList");
  });
});
