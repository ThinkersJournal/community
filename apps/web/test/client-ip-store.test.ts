import { execFileSync } from "node:child_process";
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

  it("is called at the function's base indent, not nested inside a conditional", () => {
    const lines = code.split("\n");
    const callLine = lines.find((l) => l.includes("applyClientIpHeader("));
    expect(callLine).toBeDefined();
    // Every other top-level statement in apiFetch (headers.set/.delete calls,
    // `const outgoingBody = ...`) sits at exactly two levels of indent (one
    // for the function body). A deeper indent would mean this call is nested
    // inside an `if`/block and so not truly unconditional.
    expect(callLine).toMatch(/^ {2}applyClientIpHeader\(/);
  });

  it("no headers.set/.append runs between applyClientIpHeader and the env.API.fetch call", () => {
    const applyIndex = code.indexOf("applyClientIpHeader(");
    // Search FROM applyIndex, not from the start of the file: the file header
    // mentions `env.API.fetch()` in prose before the real call site.
    const dispatchIndex = code.indexOf("env.API.fetch(", applyIndex);
    expect(dispatchIndex).toBeGreaterThan(applyIndex);
    const between = code.slice(applyIndex + "applyClientIpHeader(".length, dispatchIndex);
    expect(between).not.toMatch(/headers\.(set|append)\(/);
  });
});

/**
 * THE ENUMERATION PIN — every `API.fetch` call site in apps/web/src, found by
 * grepping the source (not a hand-maintained list, so a NEW call site added
 * later is caught automatically rather than silently skipped), must apply
 * `applyClientIpHeader` before dispatching. This is the backstop for the
 * confirmed second injection path (notifications-ws.ts / posts-live.ts
 * forwarding `context.request.headers` WHOLESALE, which — unlike `apiFetch`'s
 * hand-built `Headers` — could carry a browser-supplied `X-TJ-Client-IP`
 * straight through to the api untouched).
 */
describe("every API.fetch call site in apps/web/src applies applyClientIpHeader", () => {
  const SRC_DIR = join(import.meta.dirname, "../src");

  /**
   * Line-based `grep -rn`, filtered to actual invocations (drops prose
   * mentions in comments, e.g. api.ts's own file header, which otherwise
   * matches the same substring).
   */
  function grepApiFetchCallSites(): { file: string; line: number }[] {
    const output = execFileSync(
      "grep",
      ["-rn", "API\\.fetch(", SRC_DIR],
      { encoding: "utf8" },
    );
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((entry) => {
        const match = /^(.+?):(\d+):(.*)$/.exec(entry);
        if (!match) throw new Error(`unparsable grep line: ${entry}`);
        return { file: match[1]!, line: Number(match[2]), text: match[3]! };
      })
      .filter(({ text }) => {
        const trimmed = text.trim();
        return !trimmed.startsWith("//") && !trimmed.startsWith("*");
      })
      .map(({ file, line }) => ({ file, line }));
  }

  const callSites = grepApiFetchCallSites();

  // ⚠️ POSITIVE CONTROL: proves the grep itself still works. Without this, a
  // grep that started matching nothing (a quoting mistake, a moved src/ dir)
  // would make every case below vacuously pass via `it.each([])`.
  it("finds at least one real API.fetch call site (positive control)", () => {
    expect(callSites.length).toBeGreaterThan(0);
  });

  const byFile = [...new Set(callSites.map((c) => c.file))];

  it.each(byFile)("%s calls applyClientIpHeader before its API.fetch dispatch", (file) => {
    const code = readFileSync(file, "utf8");
    const applyCount = (code.match(/applyClientIpHeader\(/g) ?? []).length;
    expect(applyCount).toBeGreaterThanOrEqual(1);
  });
});
