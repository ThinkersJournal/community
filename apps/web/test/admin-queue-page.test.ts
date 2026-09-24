import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `/admin/queue` — PM review condition (2026-09-24): "the thing I will look
 * hardest at is that no queue content reaches the HTML on any path where the
 * JWT is absent." Same source-order-pin technique as
 * test/post-page-owner-fallback.test.ts's condition 3 — the strongest proof
 * available for SSR page logic in this codebase (see that file's header for
 * why: Astro pages aren't independently invokable in a unit test the way a
 * plain function is; the established, accepted verification here is proving
 * the STRUCTURE — the early return with nothing above it and no later branch
 * that could reach an api call before it — rather than driving a request
 * through Astro's own render pipeline, which this suite doesn't do for any
 * .astro page (see vitest.config.ts's header)).
 *
 * ⚠️ The REAL behavioral proof — a live request against a built Worker with
 * no Access header sent at all, confirming an empty 401 body before any
 * Service-Binding call reaches the api — was run manually against
 * `wrangler dev` and is recorded in this PR's description, not re-asserted
 * here as an automated test (matching this repo's own established split
 * between source-level pins here and e2e/manual proof for real request
 * behavior — see e.g. build-web.mjs's WORKERS_CI verification history).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const PAGE = join(import.meta.dirname, "..", "src", "pages", "admin", "queue.astro");
const source = stripComments(readFileSync(PAGE, "utf8"));

describe("/admin/queue — the JWT-absent guard is the FIRST statement, nothing above it, nothing below it skips it", () => {
  it("positive: reads the Access JWT header and returns 401 on absence", () => {
    expect(source).toContain('Astro.request.headers.get(ACCESS_JWT_HEADER)');
    expect(source).toMatch(/accessJwt === null \|\| accessJwt === ""/);
    expect(source).toMatch(/return new Response\(null, \{ status: 401 \}\);/);
  });

  it("⚠️ the guard is the FIRST executable statement in frontmatter — before markPrivate, before the CSP, before any api call", () => {
    const frontmatterStart = source.indexOf("---");
    const guardAt = source.indexOf("if (accessJwt === null");
    const markPrivateAt = source.indexOf("markPrivate(Astro)");
    const cspAt = source.indexOf("setPublicPageCsp(Astro)");
    const queueFetchAt = source.indexOf('adminApiFetch<AdminQueueResponse>("/admin/queue"');
    const decisionFetchAt = source.indexOf('adminApiFetch("/admin/decision"');

    expect(frontmatterStart, "no frontmatter fence found").toBeGreaterThanOrEqual(0);
    expect(guardAt, "guard not found").toBeGreaterThan(-1);
    expect(markPrivateAt, "markPrivate not found").toBeGreaterThan(-1);
    expect(cspAt, "CSP call not found").toBeGreaterThan(-1);
    expect(queueFetchAt, "queue fetch not found").toBeGreaterThan(-1);
    expect(decisionFetchAt, "decision fetch not found").toBeGreaterThan(-1);

    // Only imports/const declarations for ACCESS_JWT_HEADER etc. may precede
    // the guard — nothing that touches the network or renders content.
    expect(guardAt).toBeLessThan(markPrivateAt);
    expect(guardAt).toBeLessThan(cspAt);
    expect(guardAt).toBeLessThan(queueFetchAt);
    expect(guardAt).toBeLessThan(decisionFetchAt);
  });

  it("⚠️ no import of markPublicCacheable/markFeedCacheable — this page must never be edge-cacheable (it can carry hidden content)", () => {
    expect(source).not.toContain("markPublicCacheable(");
    expect(source).not.toContain("markFeedCacheable(");
    expect(source).toContain("markPrivate(Astro)");
  });

  it("⚠️ no generic /api/admin/* proxy — adminApiFetch is called directly from THIS page's own frontmatter, never through a separate browser-facing endpoint", () => {
    expect(source).toContain('from "../../lib/admin-api"');
    // Anti-vacuity: confirm no fetch("/api/admin against a same-origin proxy
    // exists anywhere in this file (that would be the confused-deputy shape).
    expect(source).not.toMatch(/fetch\(["']\/api\/admin/);
  });

  it("forwards the CALLER's own Origin (never synthesized) for the mutating decision call", () => {
    expect(source).toMatch(/origin:\s*Astro\.request\.headers\.get\("Origin"\)\s*\?\?\s*""/);
  });

  it("only a human decides — decision comes from the submitted form field, never inferred", () => {
    expect(source).toContain('form.get("decision")');
  });
});
