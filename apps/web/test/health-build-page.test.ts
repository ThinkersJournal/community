import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const c = strip(readFileSync(join(__dirname, "..", "src", "pages", "health", "build.ts"), "utf8"));

/**
 * Build-identity (2026-09-24) — GET /health/build, the web Worker's OWN
 * identity, NOT proxied through the api's own /health/build.
 */
describe("health/build.ts", () => {
  it("is markPrivate — live env readout, never cacheable", () => {
    expect(c).toContain("markPrivate(");
  });

  it("reads env from cloudflare:workers, NOT Astro.locals.runtime.env (removed in Astro v6, throws under astro@7)", () => {
    expect(c).toContain('from "cloudflare:workers"');
    expect(c).not.toContain("locals.runtime");
  });

  it("reports its own worker name and CF_VERSION_METADATA's id/tag/timestamp", () => {
    expect(c).toContain('worker: "web"');
    expect(c).toContain("env.CF_VERSION_METADATA");
    expect(c).toMatch(/id:\s*meta\.id/);
    expect(c).toMatch(/tag:\s*meta\.tag/);
    expect(c).toMatch(/timestamp:\s*meta\.timestamp/);
  });

  it("reads the git SHA from PUBLIC_BUILD_SHA (build-time inlined, never fabricated)", () => {
    expect(c).toContain("import.meta.env.PUBLIC_BUILD_SHA");
    expect(c).toContain("sha ?? null");
  });

  it("does NOT proxy the api's own /health/build — each Worker answers for itself", () => {
    expect(c).not.toContain("apiFetch");
  });
});
