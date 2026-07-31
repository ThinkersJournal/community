import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
describe("unsub.astro", () => {
  const c = strip(readFileSync(join(__dirname, "..", "src", "pages", "unsub.astro"), "utf8"));
  it("markPrivate, reads ?token=, calls /unsub, links to settings", () => {
    expect(c).toContain("markPrivate(");
    expect(c).toContain('searchParams.get("token")');
    expect(c).toContain("/unsub?token=");
    expect(c).toContain("/settings/notifications");
  });
  it("handles the one-click POST", () => {
    expect(c).toContain('Astro.request.method === "POST"');
  });
});
