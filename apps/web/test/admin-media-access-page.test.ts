import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `/admin/media-access` — same source-order-pin technique as
 * test/admin-queue-page.test.ts (see that file's header for why this is the
 * established, strongest available proof for SSR page logic in this
 * codebase). Plus the two-person legibility requirement (PM, 2026-09-24):
 * the rule must be VISIBLE before the click, not just enforced after it.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const PAGE = join(import.meta.dirname, "..", "src", "pages", "admin", "media-access.astro");
const source = stripComments(readFileSync(PAGE, "utf8"));

describe("/admin/media-access — the JWT-absent guard is the FIRST statement", () => {
  it("positive: reads the Access JWT header and returns 401 on absence", () => {
    expect(source).toContain("Astro.request.headers.get(ACCESS_JWT_HEADER)");
    expect(source).toMatch(/accessJwt === null \|\| accessJwt === ""/);
    expect(source).toMatch(/return new Response\(null, \{ status: 401 \}\);/);
  });

  it("⚠️ the guard is the FIRST executable statement — before markPrivate, the CSP, whoami, or the list fetch", () => {
    const guardAt = source.indexOf("if (accessJwt === null");
    const markPrivateAt = source.indexOf("markPrivate(Astro)");
    const cspAt = source.indexOf("setPublicPageCsp(Astro)");
    const whoamiAt = source.indexOf('adminApiFetch<AdminIdentityWire>("/admin/whoami"');
    const listAt = source.indexOf('adminApiFetch<AdminMediaAccessRequestsResponse>("/admin/media-access-requests"');
    const approveAt = source.indexOf('`/admin/media-access-requests/${id}/approve`');
    const requestAt = source.indexOf('adminApiFetch("/admin/media-access-requests"');

    for (const [name, pos] of [
      ["guard", guardAt], ["markPrivate", markPrivateAt], ["csp", cspAt],
      ["whoami fetch", whoamiAt], ["list fetch", listAt],
      ["approve fetch", approveAt], ["request fetch", requestAt],
    ] as const) {
      expect(pos, `${name} not found`).toBeGreaterThan(-1);
    }

    expect(guardAt).toBeLessThan(markPrivateAt);
    expect(guardAt).toBeLessThan(cspAt);
    expect(guardAt).toBeLessThan(whoamiAt);
    expect(guardAt).toBeLessThan(listAt);
    expect(guardAt).toBeLessThan(approveAt);
    expect(guardAt).toBeLessThan(requestAt);
  });

  it("⚠️ no import of markPublicCacheable/markFeedCacheable — must never be edge-cacheable", () => {
    expect(source).not.toContain("markPublicCacheable(");
    expect(source).not.toContain("markFeedCacheable(");
    expect(source).toContain("markPrivate(Astro)");
  });

  it("⚠️ no generic /api/admin/* proxy — adminApiFetch called directly from this page's own frontmatter", () => {
    expect(source).toContain('from "../../lib/admin-api"');
    expect(source).not.toMatch(/fetch\(["']\/api\/admin/);
  });
});

describe("⚠️ two-person legibility (PM requirement, 2026-09-24) — the rule is visible BEFORE the click", () => {
  it("compares the viewer's own identity (from /admin/whoami) against requestedBy, case/whitespace-insensitively — mirrors approveMediaAccess's own lower(trim()) rule", () => {
    expect(source).toMatch(/function isOwnRequest/);
    expect(source).toMatch(/requestedBy\.trim\(\)\.toLowerCase\(\)\s*===\s*viewerEmail\.trim\(\)\.toLowerCase\(\)/);
  });

  it("a self-made request renders explanatory text INSTEAD of an Approve button — not a button that fails on click", () => {
    const ownBranch = source.indexOf("isOwnRequest(r.requestedBy)");
    expect(ownBranch).toBeGreaterThan(-1);
    const nearby = source.slice(ownBranch, ownBranch + 400);
    expect(nearby).toContain("Awaiting a different admin");
    // The Approve button must be in the ELSE branch, not rendered alongside
    // the explanatory text for the same request.
    const approveButtonAt = nearby.indexOf('value="approve"');
    const explanationAt = nearby.indexOf("Awaiting a different admin");
    expect(explanationAt).toBeGreaterThan(-1);
    expect(approveButtonAt === -1 || explanationAt < approveButtonAt).toBe(true);
  });

  it("the approve action forwards intent+id via a form, not a client-side fetch", () => {
    expect(source).toContain('name="intent" value="approve"');
    expect(source).toMatch(/name="id"/);
  });
});
