import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PAGE = join(import.meta.dirname, "../src/pages/choose-username.astro");
const SERVER_ENTRY = join(import.meta.dirname, "../dist/server/entry.mjs");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(readFileSync(PAGE, "utf8"));

describe("choose-username.astro", () => {
  it("declares its cacheability via markPrivate (never cacheable — it is authed)", () => {
    expect(code).toContain("markPrivate(");
    expect(code).not.toContain("markPublicCacheable(");
    expect(code).not.toContain("markFeedCacheable(");
  });

  it("posts the chosen handle to the api username route with the CSRF token", () => {
    expect(code).toContain("/profile/username");
    expect(code).toMatch(/csrfToken/);
  });

  it("forwards the browser cookie on its api calls (it is an authed page)", () => {
    expect(code).toMatch(/request:\s*Astro\.request/);
  });

  it("branches on the api error codes, not raw status", () => {
    expect(code).toContain("USERNAME_TAKEN");
    expect(code).toContain("apiErrorCode(");
  });

  it("redirects to /feed on success", () => {
    expect(code).toMatch(/redirect\(["']\/feed["']\)/);
  });
});

describe("built route manifest (when dist/ is present)", () => {
  const built = existsSync(SERVER_ENTRY);
  it.runIf(built)("contains the /choose-username route", () => {
    expect(readFileSync(SERVER_ENTRY, "utf8")).toContain('"route":"/choose-username"');
  });
  it.skipIf(built)("SKIPPED: no dist/ — reachability is E2E + deploy-gate verified", () => {
    expect(built).toBe(false);
  });
});
