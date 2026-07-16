import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE MEDIA UPLOAD PROXY — src/pages/media-upload.ts (Task 17).
 *
 * ⚠️ SOURCE/STRUCTURE TEST, NOT A RENDER — same reasoning as
 * test/new-post-page.test.ts: this file imports `cloudflare:workers` (via
 * src/lib/api.ts) and does not run outside workerd. Proven on the wire under
 * `wrangler dev` (task report) and by the E2E spine.
 *
 * What this pins: the SAME-ORIGIN-PROXY property that makes the api's Origin
 * allowlist meaningful at all (a direct browser->api call is impossible by
 * topology, but nothing stops a FUTURE edit from routing around this file),
 * the streamed (not buffered) body, and the real-Origin forward.
 */

const PAGE = join(import.meta.dirname, "../src/pages/media-upload.ts");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const rawSource = readFileSync(PAGE, "utf8");
const code = stripComments(rawSource);

describe("exists as a POST-only, non-prerendered endpoint", () => {
  it("lives at src/pages/media-upload.ts", () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it("opts out of prerendering (it must run per-request, on every deploy target)", () => {
    expect(code).toMatch(/export const prerender = false/);
  });

  it("exports a POST handler, not a page component", () => {
    expect(code).toMatch(/export const POST: APIRoute/);
  });
});

describe("cacheability", () => {
  it("declares itself PRIVATE via the one helper", () => {
    expect(code).toContain("markPrivate(");
  });
});

describe("⚠️ proxies to the api's /media — never bypassed, never re-implemented", () => {
  it("calls apiFetch(\"/media\", ...) — the actual upload route", () => {
    expect(code).toMatch(/apiFetch[^(]*\(\s*["']\/media["']/);
  });

  it("forwards the real browser Origin, never Astro.url.origin or a synthesized value", () => {
    expect(code).toContain('context.request.headers.get("Origin")');
    expect(code).not.toMatch(/\.url\.(origin|host)/);
  });

  it("forwards the X-CSRF-Token header the browser sent", () => {
    expect(code).toMatch(/context\.request\.headers\.get\(\s*["']X-CSRF-Token["']\s*\)/);
  });

  it("forwards the session cookie via `request: context.request`", () => {
    expect(code).toMatch(/request:\s*context\.request/);
  });
});

describe("⚠️ the body is STREAMED through, never buffered or re-encoded", () => {
  it("passes context.request.body straight through as rawBody", () => {
    expect(code).toMatch(/rawBody:\s*context\.request\.body/);
  });

  it("⚠️ never calls .arrayBuffer()/.blob()/.text()/.formData() on the request — any of those would buffer it", () => {
    expect(code).not.toMatch(/context\.request\.(arrayBuffer|blob|text|formData|json)\(/);
  });

  it("does NOT reference FormData/multipart — POST /media takes raw bytes, not a multipart body", () => {
    expect(code).not.toContain("FormData");
    expect(code).not.toMatch(/multipart/i);
  });
});

describe("⚠️ propagates Set-Cookie — a revoked session's upload attempt must still clear the cookie", () => {
  it("calls applyCookies with the api response's setCookies", () => {
    expect(code).toContain("applyCookies(");
    expect(code).toContain("response.setCookies");
  });
});

describe("validates nothing itself — that is the api's job", () => {
  it("contains no size/format/quota check of its own (no magic-byte or content-length logic)", () => {
    expect(code).not.toMatch(/MAX_UPLOAD_BYTES|sniffImageFormat|content-length/i);
  });
});
