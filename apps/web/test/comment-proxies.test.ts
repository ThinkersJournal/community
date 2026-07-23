import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "pages", "api");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const AUTHED = [
  { file: "comment.ts", upstream: "/comments", method: "POST" },
  { file: "comment-update.ts", upstream: "/comments/", method: "PATCH" },
  { file: "comment-delete.ts", upstream: "/comments/", method: "DELETE" },
] as const;

describe("comment write proxies", () => {
  for (const { file, upstream, method } of AUTHED) {
    const code = stripComments(readFileSync(join(DIR, file), "utf8"));
    it(`${file} is markPrivate and forwards cookie+origin+csrf to ${method} ${upstream}`, () => {
      expect(code).toContain("markPrivate(");
      expect(code).toContain(`"${upstream}`);
      expect(code).toContain("request: context.request");
      expect(code).toContain('context.request.headers.get("Origin")');
      expect(code).toContain('context.request.headers.get("X-CSRF-Token")');
      expect(code).toContain("applyCookies(");
      if (method !== "POST") expect(code).toContain(`method: "${method}"`);
    });
  }
});

describe("GET /api/comments (anonymous passthrough)", () => {
  const code = stripComments(readFileSync(join(DIR, "comments.ts"), "utf8"));
  it("is markPrivate and hits /public/comments", () => {
    expect(code).toContain("markPrivate(");
    expect(code).toContain("/public/comments");
  });
  it("forwards NO cookie — the upstream is anonymous", () => {
    expect(code).toContain("apiFetch"); // anti-vacuity anchor
    expect(code).not.toContain("request: context.request");
  });
});
