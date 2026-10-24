// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { HEALTH_EDGE_MAX_AGE, markHealthCacheable } from "../src/lib/cache";

/**
 * `GET /health/security-ledger` (security-alerting spec §2.6 R2; plan Task 22):
 * the structural tests its sibling /health/db has, plus the helper's contract.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = stripComments(readFileSync(join(__dirname, "..", "src", "pages", "health", "security-ledger.ts"), "utf8"));

describe("GET /health/security-ledger public proxy", () => {
  it("calls apiFetch for exactly the api's route (anti-vacuity anchor)", () => {
    expect(code).toContain('apiFetch<unknown>("/health/security-ledger")');
  });

  it("is edge-cached by markHealthCacheable and by nothing else", () => {
    expect(code).toContain("markHealthCacheable(");
    for (const other of ["markPrivate(", "markPublicCacheable(", "markFeedCacheable("]) expect(code).not.toContain(other);
  });

  it("passes the api's status through, so `stale` (503) reaches a monitor as non-200", () => {
    expect(code).toContain("status: response.status");
  });

  it("is anonymous: the apiFetch call forwards no request", () => {
    expect(code.slice(code.lastIndexOf("apiFetch"))).not.toMatch(/request/);
  });
});

describe("markHealthCacheable", () => {
  const context = (cookie: string | null) => ({
    request: new Request("https://community.thinkersjournal.com/health/security-ledger", {
      headers: cookie === null ? {} : { Cookie: cookie },
    }),
    response: { headers: new Headers() },
    cache: { set: vi.fn() },
  });

  it("60 s at the edge, NO stale-while-revalidate, no tags", () => {
    const ctx = context(null);
    expect(markHealthCacheable(ctx)).toBe(true);
    expect(HEALTH_EDGE_MAX_AGE).toBe(60);
    expect(ctx.cache.set).toHaveBeenCalledWith({ maxAge: 60, swr: 0, tags: [] });
  });

  it("refuses to cache a request that carries a session (control: the case above caches)", () => {
    const ctx = context("tj_session=abc");
    expect(markHealthCacheable(ctx)).toBe(false);
    expect(ctx.cache.set).toHaveBeenCalledWith(false);
  });
});
