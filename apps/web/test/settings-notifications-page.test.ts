import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const c = strip(readFileSync(join(__dirname, "..", "src", "pages", "settings", "notifications.astro"), "utf8"));
describe("settings/notifications.astro", () => {
  it("is authed (markPrivate) and talks to /notification-prefs both ways", () => {
    expect(c).toContain("markPrivate(");
    expect(c).toContain("/notification-prefs");
    expect(c).toContain('method: "PUT"');
  });
  it("forwards Origin + CSRF and applies cookies on save", () => {
    expect(c).toContain('Astro.request.headers.get("Origin")');
    expect(c).toContain("csrfToken");
    expect(c).toContain("applyCookies(");
  });
  it("renders the master toggle and three category selects", () => {
    expect(c).toContain('name="masterEnabled"');
    expect(c).toContain('name="direct"');
    expect(c).toContain('name="reactions"');
    expect(c).toContain('name="follows"');
  });
});
