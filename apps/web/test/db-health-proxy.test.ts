import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `GET /health/db` — the public proxy to the api's DB-reachability readout, for
 * an external uptime monitor to poll (the api itself is binding-only).
 *
 * Source-level pins, matching test/comment-proxies.test.ts's convention. The
 * load-bearing one is `markPrivate`: page-cache-inventory's SWEEP A only checks
 * that SOME cache helper is called, NOT which — so a future edit that switched
 * this to a CACHING helper would pass the inventory while silently caching the
 * readout, and a cached 200 is indistinguishable from a live one, masking the
 * exact outage this endpoint exists to catch. This test is what catches that.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const ROUTE = join(__dirname, "..", "src", "pages", "health", "db.ts");
const code = stripComments(readFileSync(ROUTE, "utf8"));

describe("GET /health/db public proxy (db-health-probe)", () => {
  it("calls apiFetch (anti-vacuity anchor)", () => {
    expect(code).toContain("apiFetch");
  });

  it("is markPrivate and NOTHING that caches — a cached readout would mask the outage it catches", () => {
    expect(code).toContain("markPrivate(");
    expect(code).not.toContain("markPublicCacheable(");
    expect(code).not.toContain("markFeedCacheable(");
  });

  it("proxies the api's /health/db and passes its STATUS through, so a 503 reaches the monitor as non-200", () => {
    expect(code).toContain('"/health/db"');
    expect(code).toContain("status: response.status");
  });

  it("is ANONYMOUS — the apiFetch call forwards no request/cookie (the readout carries no viewer state)", () => {
    // Scope to the apiFetch call site onward (markPrivate legitimately reads
    // context.request above it). Assert no `request` reference in that region.
    const apiFetchCall = code.slice(code.lastIndexOf("apiFetch"));
    expect(apiFetchCall).not.toMatch(/request/);
  });
});
