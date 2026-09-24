import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Endpoint/UI audit, 2026-09-24 — the report/block proxy hops. Same pattern
 * as comment-proxies.test.ts: source-level pins on the actual proxy files,
 * not a live fetch (no api Worker running here).
 */

const DIR = join(__dirname, "..", "src", "pages", "api");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const AUTHED = [
  { file: "report.ts", upstream: "/reports", method: "POST" },
  { file: "block.ts", upstream: "/blocks", method: "POST" },
  { file: "unblock.ts", upstream: "/blocks/", method: "DELETE" },
] as const;

describe("report/block write proxies", () => {
  for (const { file, upstream, method } of AUTHED) {
    const code = stripComments(readFileSync(join(DIR, file), "utf8"));
    it(`${file} is markPrivate and forwards cookie+origin+csrf to ${method} ${upstream}`, () => {
      expect(code).toContain("markPrivate(");
      expect(code).toContain(upstream);
      expect(code).toContain("request: context.request");
      expect(code).toContain('context.request.headers.get("Origin")');
      expect(code).toContain('context.request.headers.get("X-CSRF-Token")');
      expect(code).toContain("applyCookies(");
      if (method !== "POST") expect(code).toContain(`method: "${method}"`);
    });
  }

  it("report.ts does not read or transform the upstream response body (nothing here can leak threshold state)", () => {
    const code = stripComments(readFileSync(join(DIR, "report.ts"), "utf8"));
    // The only place `.text` may appear is forwarding it verbatim into the
    // Response this proxy returns — never parsed, never branched on.
    expect(code).toContain("new Response(response.text");
    expect(code).not.toMatch(/response\.text\s*\)\s*\.|JSON\.parse\(response\.text\)/);
  });

  it("unblock.ts rejects a non-uuid blockedId before ever reaching the api (mirrors unfollow.ts)", () => {
    const code = stripComments(readFileSync(join(DIR, "unblock.ts"), "utf8"));
    expect(code).toMatch(/UUID_RE\.test\(blockedId\)/);
  });
});

describe("GET /api/blocks (status + own list)", () => {
  const code = stripComments(readFileSync(join(DIR, "blocks.ts"), "utf8"));

  it("is markPrivate and has two modes: /blocks/status (batched, per-viewer) and /blocks (own list)", () => {
    expect(code).toContain("markPrivate(");
    expect(code).toContain("/blocks/status?");
    expect(code).toContain('apiFetch<BlockedList>("/blocks"');
  });

  it("a 401 on ?status= degrades to a logged-out shape, never propagates the 401 itself", () => {
    expect(code).toMatch(/statusResp\.status === 401[\s\S]{0,200}viewerLoggedIn: false/);
  });

  it("a 401 on the bare list degrades to an empty list, not a propagated 401 (an unauthenticated settings-page fetch stays quiet)", () => {
    expect(code).toMatch(/listResp\.status === 401[\s\S]{0,120}users: \[\]/);
  });
});
