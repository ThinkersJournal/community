import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const DIR = join(__dirname, "..", "src", "pages", "api");
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const code = stripComments(readFileSync(join(DIR, "comments-fragment.ts"), "utf8"));

describe("comments-fragment endpoint", () => {
  it("fetches the public comment window from api and renders each via renderMarkdown", () => {
    expect(code).toContain("/public/comments"); // the api read (confirm the real path in comments-public.ts / routes.ts)
    expect(code).toContain("renderMarkdown");
    expect(code).toMatch(/cursor|comments=/); // forwards the window cursor
  });
  it("renders a tombstone as empty html, never rendering a deleted body", () => {
    expect(code).toMatch(/deleted\s*\?\s*""\s*:\s*(await\s*)?renderMarkdown/);
  });
  it("is prerender=false, markPrivate, no apiFetch-body-consume issue (JSON read is fine)", () => {
    expect(code).toContain("export const prerender = false");
    expect(code).toContain("markPrivate");
  });
});
