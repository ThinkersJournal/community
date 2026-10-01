import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `GET /health/schema` — the public proxy to the api's migration-applied
 * readout, for `scripts/check-migrations-applied.mjs` to poll (the api itself
 * is binding-only). Mirrors test/db-health-proxy.test.ts's convention exactly
 * — source-level pins, not an HTTP-level test (apps/web/vitest.config.ts runs
 * plain Node, no Service Binding to drive the real `.astro`/page pipeline
 * through; see that config's own header).
 *
 * The load-bearing pin is `markPrivate`: a cached `{"applied":true}` would
 * make the deploy gate pass FOREVER, even after a rollback or a schema
 * regression — exactly the failure #116 exists to prevent.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const ROUTE = join(__dirname, "..", "src", "pages", "health", "schema.ts");
const code = stripComments(readFileSync(ROUTE, "utf8"));

describe("GET /health/schema public proxy (deploy-time migration gate, #116)", () => {
  it("calls apiFetch (anti-vacuity anchor)", () => {
    expect(code).toContain("apiFetch");
  });

  it("is markPrivate and NOTHING that caches — a cached readout would defeat the gate forever", () => {
    expect(code).toContain("markPrivate(");
    expect(code).not.toContain("markPublicCacheable(");
    expect(code).not.toContain("markFeedCacheable(");
  });

  it("proxies the api's /health/schema and passes its STATUS through, so the api's 400/503 both reach the gate script unchanged", () => {
    expect(code).toContain('"/health/schema?migration="');
    expect(code).toContain("status: response.status");
  });

  it("forwards the `migration` query param to the api", () => {
    expect(code).toContain('searchParams.get("migration")');
    expect(code).toContain("encodeURIComponent(migration)");
  });

  it("is ANONYMOUS — the apiFetch call forwards no request/cookie (the readout carries no viewer state)", () => {
    // Scope to the apiFetch call site onward (markPrivate legitimately reads
    // context.request above it). Assert no `request` reference in that region.
    const apiFetchCall = code.slice(code.lastIndexOf("apiFetch"));
    expect(apiFetchCall).not.toMatch(/request/);
  });
});
