import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The DSA notice intake pages (Part of #113) — same source-order-pin
 * technique as test/admin-media-access-page.test.ts and
 * test/admin-queue-page.test.ts (see either file's header for why this is
 * the established, strongest available proof for SSR page logic in this
 * codebase: Astro pages aren't independently invokable in a unit test the
 * way a plain function is, so this suite pins the STRUCTURE of the source
 * rather than driving a request through Astro's own render pipeline).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const PAGES_DIR = join(import.meta.dirname, "..", "src", "pages");

const dsaNoticeSource = stripComments(readFileSync(join(PAGES_DIR, "dsa-notice.astro"), "utf8"));
const confirmSource = stripComments(
  readFileSync(join(PAGES_DIR, "dsa-notice", "confirm.astro"), "utf8"),
);
const adminDsaNoticesSource = stripComments(
  readFileSync(join(PAGES_DIR, "admin", "dsa-notices.astro"), "utf8"),
);
const slugSource = stripComments(
  readFileSync(join(PAGES_DIR, "[handle]", "[slug].astro"), "utf8"),
);

describe("dsa-notice.astro", () => {
  it("includes the required goodFaith checkbox", () => {
    expect(dsaNoticeSource).toMatch(
      /<input type="checkbox" name="goodFaith" required \/>/,
    );
    expect(dsaNoticeSource).toContain(
      "I believe in good faith that this information is accurate and complete",
    );
  });

  it("widens its CSP for Turnstile", () => {
    expect(dsaNoticeSource).toContain("setPublicPageCsp(Astro, { turnstile: true })");
  });

  it("uses REPORT_REASONS from @thinkersjournal/shared for the reason select", () => {
    expect(dsaNoticeSource).toContain('import { REPORT_REASONS } from "@thinkersjournal/shared"');
    expect(dsaNoticeSource).toContain("REPORT_REASONS.map(");
  });

  it("POSTs to /dsa-notice", () => {
    expect(dsaNoticeSource).toContain('apiFetch("/dsa-notice"');
  });

  it("forwards the browser's Origin verbatim, never this app's own", () => {
    expect(dsaNoticeSource).toContain('origin: Astro.request.headers.get("Origin") ?? ""');
  });
});

describe("dsa-notice/confirm.astro", () => {
  it("⚠️ its only `method: \"POST\"` api call is inside the POST branch", () => {
    const postCallAt = confirmSource.indexOf('method: "POST"');
    const ifPostAt = confirmSource.indexOf('Astro.request.method === "POST"');
    expect(postCallAt, '`method: "POST"` not found').toBeGreaterThan(-1);
    expect(ifPostAt, "POST-method branch not found").toBeGreaterThan(-1);
    expect(ifPostAt).toBeLessThan(postCallAt);

    // And there is exactly ONE such call in the whole file — the GET/peek
    // path must never carry a `method: "POST"` option.
    const occurrences = confirmSource.split('method: "POST"').length - 1;
    expect(occurrences).toBe(1);

    // The POST call must be textually INSIDE that branch's block, not merely
    // after its opening brace elsewhere in the file — find the matching
    // close for the `if` block that opens right after `ifPostAt` and assert
    // the POST call falls before it.
    const blockOpenAt = confirmSource.indexOf("{", ifPostAt);
    let depth = 0;
    let blockCloseAt = -1;
    for (let i = blockOpenAt; i < confirmSource.length; i++) {
      if (confirmSource[i] === "{") depth++;
      else if (confirmSource[i] === "}") {
        depth--;
        if (depth === 0) {
          blockCloseAt = i;
          break;
        }
      }
    }
    expect(blockCloseAt, "could not find the end of the POST branch's block").toBeGreaterThan(-1);
    expect(postCallAt).toBeLessThan(blockCloseAt);
  });

  it("never POSTs to the api on GET — the peek call has no method option at all", () => {
    expect(confirmSource).toContain('apiFetch<{ ok: boolean }>(');
    const peekAt = confirmSource.indexOf("apiFetch<{ ok: boolean }>(");
    const ifPostAt = confirmSource.indexOf('Astro.request.method === "POST"');
    expect(peekAt, "peek call not found").toBeGreaterThan(-1);
    expect(ifPostAt).toBeLessThan(peekAt); // the peek lives in the else branch, textually after the if
  });

  it("POSTs to /dsa-notice/confirm", () => {
    expect(confirmSource).toContain('apiFetch("/dsa-notice/confirm"');
  });
});

describe("admin/dsa-notices.astro", () => {
  it("⚠️ the Access-JWT-absent guard is the FIRST statement — before markPrivate, the CSP, or any api call", () => {
    expect(adminDsaNoticesSource).toContain("Astro.request.headers.get(ACCESS_JWT_HEADER)");
    expect(adminDsaNoticesSource).toMatch(/accessJwt === null \|\| accessJwt === ""/);
    expect(adminDsaNoticesSource).toMatch(/return new Response\(null, \{ status: 401 \}\);/);

    const guardAt = adminDsaNoticesSource.indexOf("if (accessJwt === null");
    const markPrivateAt = adminDsaNoticesSource.indexOf("markPrivate(Astro)");
    const cspAt = adminDsaNoticesSource.indexOf("setPublicPageCsp(Astro)");
    const decisionAt = adminDsaNoticesSource.indexOf('adminApiFetch("/admin/decision"');
    const listAt = adminDsaNoticesSource.indexOf(
      'adminApiFetch<AdminDsaNoticesResponse>("/admin/dsa-notices"',
    );

    for (const [name, pos] of [
      ["guard", guardAt],
      ["markPrivate", markPrivateAt],
      ["csp", cspAt],
      ["decision fetch", decisionAt],
      ["list fetch", listAt],
    ] as const) {
      expect(pos, `${name} not found`).toBeGreaterThan(-1);
    }

    expect(guardAt).toBeLessThan(markPrivateAt);
    expect(guardAt).toBeLessThan(cspAt);
    expect(guardAt).toBeLessThan(decisionAt);
    expect(guardAt).toBeLessThan(listAt);
  });

  it("⚠️ the only mutating admin call is adminApiFetch(\"/admin/decision\", …) — no other mutating admin path", () => {
    const mutatingCalls = [...adminDsaNoticesSource.matchAll(/adminApiFetch\(\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(mutatingCalls).toEqual(["/admin/decision"]);
  });

  it("no generic /api/admin/* proxy", () => {
    expect(adminDsaNoticesSource).not.toMatch(/fetch\(["']\/api\/admin/);
  });
});

describe("[handle]/[slug].astro — the plain, signed-out-visible DSA report link", () => {
  it("links to /dsa-notice?post= for the post itself", () => {
    expect(slugSource).toContain("/dsa-notice?post=");
  });

  it("links to /dsa-notice?comment= for each comment", () => {
    expect(slugSource).toContain("/dsa-notice?comment=");
  });

  it("the post-level link is NOT gated behind the signed-in post-report island (no `hidden` on it)", () => {
    const linkAt = slugSource.indexOf('class="dsa-notice-link"');
    expect(linkAt).toBeGreaterThan(-1);
    const nearby = slugSource.slice(linkAt, linkAt + 200);
    expect(nearby).not.toContain("hidden");
  });
});
