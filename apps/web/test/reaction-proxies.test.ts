import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "pages", "api");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("reaction toggle proxies", () => {
  for (const { file, upstream } of [
    { file: "react.ts", upstream: '"/reactions"' },
    { file: "unreact.ts", upstream: "`/reactions?" },
  ] as const) {
    const code = stripComments(readFileSync(join(DIR, file), "utf8"));
    it(`${file} is markPrivate, authed, and targets /reactions`, () => {
      expect(code).toContain("markPrivate(");
      expect(code).toContain(upstream);
      expect(code).toContain("request: context.request");
      expect(code).toContain('context.request.headers.get("X-CSRF-Token")');
      expect(code).toContain("applyCookies(");
    });
  }
  it("unreact maps to the api's DELETE", () => {
    const code = stripComments(readFileSync(join(DIR, "unreact.ts"), "utf8"));
    expect(code).toContain('method: "DELETE"');
  });
});

describe("GET /api/reactions (merge)", () => {
  const code = stripComments(readFileSync(join(DIR, "reactions.ts"), "utf8"));
  it("is markPrivate; counts hop is ANONYMOUS, mine hop is authed", () => {
    expect(code).toContain("markPrivate(");
    expect(code).toContain("/public/reactions");
    expect(code).toContain("/reactions/mine");
    // The counts fetch call must not carry the browser request…
    const countsCall = code.slice(code.indexOf("/public/reactions"), code.indexOf("/reactions/mine"));
    expect(countsCall).not.toContain("request: context.request");
    // …the mine fetch must.
    const mineCall = code.slice(code.indexOf("/reactions/mine"));
    expect(mineCall).toContain("request: context.request");
  });
  it("propagates upstream errors honestly (no 200-masking) and merges csrf", () => {
    expect(code).toContain("counts.status"); // branches on it
    expect(code).toContain("/auth/csrf");
    expect(code).toContain("viewerLoggedIn");
  });
});
