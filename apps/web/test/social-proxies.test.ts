import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "../src/pages/api");
const SERVER_ENTRY = join(import.meta.dirname, "../dist/server/entry.mjs");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe.each([
  ["follow.ts", "POST", "/follows"],
  ["unfollow.ts", "POST", "/follows/"],
  ["social.ts", "GET", "/public/social"],
])("%s", (file, method, apiPath) => {
  const code = stripComments(readFileSync(join(DIR, file), "utf8"));

  it(`exports the ${method} APIRoute`, () => {
    expect(code).toMatch(new RegExp(`export const ${method}\\s*:\\s*APIRoute`));
  });

  it("declares prerender = false", () => {
    expect(code).toContain("export const prerender = false");
  });

  it("marks itself private (per-viewer, never cached) with the wrapped context", () => {
    expect(code).toContain("markPrivate(");
    expect(code).toMatch(/response:\s*\{\s*headers\s*\}/);
  });

  it(`proxies to the api path ${apiPath}`, () => {
    expect(code).toContain(apiPath);
  });

  it("forwards the browser cookie to the api (authed hop)", () => {
    expect(code).toMatch(/request:\s*context\.request/);
  });
});

describe("mutating proxies forward the CSRF token + origin", () => {
  it.each(["follow.ts", "unfollow.ts"])("%s echoes X-CSRF-Token and Origin", (file) => {
    const code = stripComments(readFileSync(join(DIR, file), "utf8"));
    expect(code).toMatch(/csrfToken/);
    expect(code).toMatch(/origin/i);
    expect(code).toContain("applyCookies(");
  });
});

describe("built route manifest (when dist/ is present)", () => {
  const built = existsSync(SERVER_ENTRY);
  it.runIf(built)("contains all three /api/* routes", () => {
    const entry = readFileSync(SERVER_ENTRY, "utf8");
    expect(entry).toContain('"route":"/api/follow"');
    expect(entry).toContain('"route":"/api/unfollow"');
    expect(entry).toContain('"route":"/api/social"');
  });
  it.skipIf(built)("SKIPPED: no dist/ — reachability is E2E + deploy-gate verified", () => {
    expect(built).toBe(false);
  });
});
