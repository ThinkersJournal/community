import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "pages", "api");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = stripComments(readFileSync(join(DIR, "notifications-ws.ts"), "utf8"));

describe("notifications-ws proxy", () => {
  it("forwards the upgrade to /notifications/ws over the API Service Binding, carrying all headers", () => {
    expect(code).toContain("/notifications/ws");
    expect(code).toContain("API.fetch"); // over the Service Binding
    expect(code).toContain("Upgrade"); // gates on the upgrade
    // ⚠️ ANTI-VACUITY: assert the headers are forwarded (via a COPY, `h` — see
    // the injection-closing test below) as the fetch init — not merely that
    // the substring "context.request.headers" appears (it also appears in the
    // `.get("Upgrade")` gate). A future `headers: filterHeaders(...)` that
    // dropped the Sec-WebSocket-* handshake headers — SPIKE FACT 2, which
    // breaks the upgrade — would fail this.
    expect(code).toMatch(/new Headers\(context\.request\.headers\)/);
    expect(code).toMatch(/headers:\s*h\b/);
  });

  it("applies applyClientIpHeader to the copy before dispatching — closes the X-TJ-Client-IP injection the wholesale forward would otherwise open", () => {
    // Forwarding `context.request.headers` wholesale (the whole point of the
    // test above) would otherwise let a browser's own `X-TJ-Client-IP` reach
    // the api untouched — the second injection path fix round 1 found.
    expect(code).toMatch(/applyClientIpHeader\(h,/);
  });

  it("hand-reconstructs the 101 as a fresh Response carrying the client webSocket (Task-0 spike: the adapter won't pass a raw 101 through)", () => {
    // ⚠️ ANTI-VACUITY: pin the RECONSTRUCTION shape, not just that "101" and
    // "webSocket" appear somewhere — the `upstream.status === 101 && ws` guard
    // and the `.webSocket` extraction contain both even if the return were
    // regressed back to `return upstream` (the exact SPIKE FACT 1 500-handshake
    // bug). Requiring `new Response(null, { status: 101, ... webSocket ... })`
    // co-located fails on that regression.
    expect(code).toMatch(/new Response\(\s*null[\s\S]{0,160}status:\s*101[\s\S]{0,160}webSocket/);
  });

  it("never passes a bare 101 through the non-101 fallback (would RangeError without a webSocket)", () => {
    // The fallback runs when the status isn't 101 OR it's a 101 with no
    // webSocket (broken upstream). `new Response(body, {status:101})` without a
    // webSocket throws — coerce that case to 502 so the proxy degrades cleanly.
    expect(code).toMatch(/upstream\.status === 101 \? 502/);
  });

  it("is prerender=false", () => {
    expect(code).toContain("export const prerender = false");
  });

  it("declares itself uncacheable via markPrivate and never uses apiFetch (which would consume the 101)", () => {
    expect(code).toContain("markPrivate");
    expect(code).not.toContain("apiFetch");
  });
});
