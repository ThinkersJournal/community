import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readRouteManifest, serverBuilt } from "./helpers/route-manifest";

const DIR = join(import.meta.dirname, "../src/pages/api");

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

describe("social.ts distinguishes 401 (not logged in) from other upstream errors", () => {
  const code = stripComments(readFileSync(join(DIR, "social.ts"), "utf8"));

  it("checks for 401 explicitly rather than collapsing all non-200s", () => {
    expect(code).toMatch(/401/);
  });

  it("propagates non-401 upstream failures instead of masquerading as logged-out", () => {
    expect(code).toMatch(/statusResp\.status\s*!==\s*200/);
    expect(code).toMatch(/status:\s*statusResp\.status/);
  });
});

describe("social.ts ?status= mode threads the viewer's own id for self-hide", () => {
  const code = stripComments(readFileSync(join(DIR, "social.ts"), "utf8"));

  it("includes viewerId on the logged-in (200) path, sourced from the api response", () => {
    // Positive: the 200 branch forwards the api's viewerId through to the island.
    expect(code).toMatch(/viewerId:\s*statusResp\.data\?\.\s*viewerId\s*\?\?\s*null/);
  });

  it("includes viewerId: null on the logged-out (401) path", () => {
    expect(code).toMatch(/viewerLoggedIn:\s*false,\s*csrfToken:\s*null,\s*viewerId:\s*null/);
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
  it.runIf(serverBuilt)("contains all three /api/* routes", () => {
    const manifest = readRouteManifest();
    expect(manifest).toContain('"route":"/api/follow"');
    expect(manifest).toContain('"route":"/api/unfollow"');
    expect(manifest).toContain('"route":"/api/social"');
  });
  it.skipIf(serverBuilt)("SKIPPED: no dist/ — reachability is E2E + deploy-gate verified", () => {
    expect(serverBuilt).toBe(false);
  });
});
