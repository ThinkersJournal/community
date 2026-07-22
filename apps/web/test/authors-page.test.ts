import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PAGE = join(import.meta.dirname, "../src/pages/authors.astro");
const HOME = join(import.meta.dirname, "../src/pages/index.astro");
const SERVER_ENTRY = join(import.meta.dirname, "../dist/server/entry.mjs");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = stripComments(readFileSync(PAGE, "utf8"));

describe("authors.astro", () => {
  it("declares markFeedCacheable (short-TTL, untagged) and nothing else", () => {
    expect(code).toContain("markFeedCacheable(");
    expect(code).not.toContain("markPublicCacheable(");
    expect(code).not.toContain("markPrivate(");
  });

  it("⚠️ is ANONYMOUS by construction — its /public/authors fetch forwards no cookie", () => {
    const call = /apiFetch<[^;]*\/public\/authors[^;]*\);/.exec(code);
    expect(call, "authors page does not call /public/authors").not.toBeNull();
    expect(call![0]).not.toMatch(/request:/);
  });

  it("sets a CSP (it carries the bundled follow island)", () => {
    expect(code).toContain("setPublicPageCsp(");
  });

  it("renders a follow button per author (island hydrates state) and mounts the island", () => {
    expect(code).toMatch(/data-follow-btn/);
    expect(code).toMatch(/data-user-id=\{author\.userId\}/);
    expect(code).toMatch(/import\s+\{\s*initSocialIsland\s*\}\s+from\s+["']\.\.\/scripts\/social["']/);
  });

  it("pages via a ?cursor= link", () => {
    expect(code).toMatch(/\/authors\?cursor=/);
  });

  it("adopts the PageLayout band while keeping cache + CSP + island", () => {
    expect(code).toMatch(/<PageLayout\s/);
    expect(code).toContain("markFeedCacheable(");
    expect(code).toContain("setPublicPageCsp(");
    expect(code).toMatch(/initSocialIsland/);
  });
});

describe("home page nav (index.astro)", () => {
  const home = stripComments(readFileSync(HOME, "utf8"));
  it("links to /authors and /feed", () => {
    expect(home).toContain('href="/authors"');
    expect(home).toContain('href="/feed"');
  });
});

describe("built route manifest (when dist/ is present)", () => {
  const built = existsSync(SERVER_ENTRY);
  it.runIf(built)("contains the /authors route", () => {
    expect(readFileSync(SERVER_ENTRY, "utf8")).toContain('"route":"/authors"');
  });
  it.skipIf(built)("SKIPPED: no dist/ — reachability is E2E + deploy-gate verified", () => {
    expect(built).toBe(false);
  });
});
