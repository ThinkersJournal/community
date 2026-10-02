import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "pages", "api");
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const code = stripComments(readFileSync(join(DIR, "posts-live.ts"), "utf8"));

describe("posts-live proxy", () => {
  it("forwards to /posts/live over the API Service Binding, carrying postId + wholesale headers", () => {
    expect(code).toContain("/posts/live");
    expect(code).toContain("API.fetch");
    // Wholesale-copied into `h` (a COPY, not the incoming Headers object
    // itself — see applyClientIpHeader below), not filtered down.
    expect(code).toMatch(/new Headers\(context\.request\.headers\)/);
    expect(code).toMatch(/headers:\s*h\b/);
    expect(code).toContain("Upgrade");
    expect(code).toMatch(/postId/); // forwards the query param
  });

  it("applies applyClientIpHeader to the copy before dispatching — closes the X-TJ-Client-IP injection the wholesale forward would otherwise open", () => {
    expect(code).toMatch(/applyClientIpHeader\(h,/);
  });
  it("hand-reconstructs the 101 and coerces a bare 101 to 502", () => {
    expect(code).toMatch(/new Response\(\s*null[\s\S]{0,160}status:\s*101[\s\S]{0,160}webSocket/);
    expect(code).toMatch(/upstream\.status === 101 \? 502/);
  });
  it("is prerender=false, declares markPrivate, and never uses apiFetch", () => {
    expect(code).toContain("export const prerender = false");
    expect(code).toContain("markPrivate");
    expect(code).not.toContain("apiFetch");
  });
});
