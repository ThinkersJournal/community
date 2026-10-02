import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CLIENT_IP_HEADER } from "@thinkersjournal/shared";

import {
  applyClientIpHeader,
  clientIpStore,
  runWithClientIp,
} from "../src/lib/client-ip-store";

/**
 * `clientIpStore` / `runWithClientIp` / `applyClientIpHeader` — the fix for the
 * confirmed production bug where `CF-Connecting-IP` does not survive the
 * web→api Service Binding (see src/lib/api.ts's file header, item 3).
 *
 * ⚠️ `apiFetch` ITSELF cannot be driven here — it imports `cloudflare:workers`,
 * unresolvable outside workerd (see vitest.config.ts's header and
 * test/outgoing-body.test.ts's, which hit the same wall for `resolveOutgoingBody`).
 * So, per the same pattern: the real logic is pulled into these plain,
 * directly-testable functions, and api.ts's use of them is pinned structurally
 * below rather than driven.
 */
describe("runWithClientIp", () => {
  it("seeds the store with the request's CF-Connecting-IP for the life of `next`", () => {
    const request = new Request("https://example.test/", {
      headers: { "CF-Connecting-IP": "203.0.113.7" },
    });
    let seen: string | null | undefined;
    runWithClientIp(request, () => {
      seen = clientIpStore.getStore()?.clientIp;
    });
    expect(seen).toBe("203.0.113.7");
  });

  it("seeds a null clientIp when the request has no CF-Connecting-IP", () => {
    const request = new Request("https://example.test/");
    let seen: string | null | undefined;
    runWithClientIp(request, () => {
      seen = clientIpStore.getStore()?.clientIp;
    });
    expect(seen).toBeNull();
  });

  it("the store is gone once `next` returns — no leak outside the request", () => {
    const request = new Request("https://example.test/", {
      headers: { "CF-Connecting-IP": "203.0.113.7" },
    });
    runWithClientIp(request, () => undefined);
    expect(clientIpStore.getStore()).toBeUndefined();
  });
});

describe("applyClientIpHeader", () => {
  it("sets CLIENT_IP_HEADER to the given ip", () => {
    const headers = new Headers();
    applyClientIpHeader(headers, "203.0.113.7");
    expect(headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.7");
  });

  it("overrides a pre-existing CLIENT_IP_HEADER rather than leaving it alone", () => {
    const headers = new Headers({ [CLIENT_IP_HEADER]: "6.6.6.6" });
    applyClientIpHeader(headers, "203.0.113.7");
    expect(headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.7");
  });

  it("removes a pre-existing CLIENT_IP_HEADER when ip is null — never left as a stale/attacker value", () => {
    const headers = new Headers({ [CLIENT_IP_HEADER]: "6.6.6.6" });
    applyClientIpHeader(headers, null);
    expect(headers.has(CLIENT_IP_HEADER)).toBe(false);
  });

  it("sends no header at all when ip is null and none was pre-existing", () => {
    const headers = new Headers();
    applyClientIpHeader(headers, null);
    expect(headers.has(CLIENT_IP_HEADER)).toBe(false);
  });
});

/**
 * SOURCE-LEVEL PIN — same technique as test/login-page.test.ts: `api.ts`
 * imports `cloudflare:workers`, so `apiFetch` can't be driven directly. This
 * pins that `apiFetch` calls `applyClientIpHeader` UNCONDITIONALLY (not inside
 * an `if`) and AFTER every other header it sets, which is the property that
 * actually keeps a caller or browser from ever overriding it.
 */
describe("apiFetch wires applyClientIpHeader in unconditionally and last", () => {
  const code = readFileSync(join(import.meta.dirname, "../src/lib/api.ts"), "utf8");

  it("calls applyClientIpHeader with no surrounding `if`", () => {
    const lines = code.split("\n");
    const callIndex = lines.findIndex((l) => l.includes("applyClientIpHeader("));
    expect(callIndex).toBeGreaterThanOrEqual(0);
    // The three lines immediately above the call are comment lines, not an `if (`.
    const precedingCode = lines
      .slice(Math.max(0, callIndex - 3), callIndex)
      .filter((l) => !l.trim().startsWith("//"));
    expect(precedingCode.join("\n")).not.toMatch(/if\s*\(/);
  });

  it("is the LAST header set before the outgoing body is resolved", () => {
    const applyIndex = code.indexOf("applyClientIpHeader(");
    const bodyResolveIndex = code.indexOf("resolveOutgoingBody(");
    expect(applyIndex).toBeGreaterThan(0);
    expect(bodyResolveIndex).toBeGreaterThan(applyIndex);
  });
});
