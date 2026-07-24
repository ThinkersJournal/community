import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "..", "src", "pages", "notifications.astro"), "utf8");

describe("/notifications page", () => {
  it("is markPrivate (one cache helper) and fetches with the cookie", () => {
    expect(src).toContain("markPrivate(Astro)");
    expect(src).toContain("request: Astro.request");
    expect(src).toContain("/notifications");
  });
  it("uses the safe manual-302 redirect on 401, NOT Astro.redirect", () => {
    expect(src).toContain("status: 302");
    expect(src).toContain("applyCookies(");
    expect(src).not.toContain("Astro.redirect");
  });
  it("collapses rows for display", () => {
    expect(src).toContain("collapseNotifications(");
  });
});
