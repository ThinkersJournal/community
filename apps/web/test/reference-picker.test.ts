// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { POST } from "../src/pages/api/post-reference";
import { insertRefAtCursor, messageForFailure } from "../src/scripts/reference-picker";
import { env } from "./helpers/cloudflare-workers-stub";

/**
 * M3.4b: the author-side "Insert a link card" control. Pure helpers, the browser -> api proxy, and a source scan of
 * the island (it needs a DOM, which this node project does not have).
 */

describe("insertRefAtCursor", () => {
  it("puts the token on its own line at the cursor, mid-line", () => {
    const r = insertRefAtCursor("hello world", 5, "tok1");
    expect(r.value).toBe("hello\n{{ref:tok1}}\n world");
    expect(r.cursor).toBe("hello\n{{ref:tok1}}\n".length);
  });

  it("does not double the newline when the cursor already sits on a line boundary", () => {
    expect(insertRefAtCursor("a\nb", 2, "t").value).toBe("a\n{{ref:t}}\nb");
    expect(insertRefAtCursor("a\n\nb", 2, "t").value).toBe("a\n\n{{ref:t}}\nb");
  });

  it("handles an empty textarea and the very end", () => {
    expect(insertRefAtCursor("", 0, "t").value).toBe("{{ref:t}}\n");
    expect(insertRefAtCursor("abc", 3, "t").value).toBe("abc\n{{ref:t}}\n");
  });

  it("clamps an out-of-range cursor and never drops existing text", () => {
    const text = "keep me";
    expect(insertRefAtCursor(text, 999, "t").value.startsWith(text)).toBe(true);
    expect(insertRefAtCursor(text, -4, "t").value.endsWith(text)).toBe(true);
  });
});

describe("messageForFailure", () => {
  it("names a plain, human reason for each failure class", () => {
    const m422 = messageForFailure(422, { code: "REFERENCE_FAILED", reason: "blocked_target" });
    const m429 = messageForFailure(429, { code: "rate_limited" });
    const m404 = messageForFailure(404, { code: "post_not_found" });
    const mNet = messageForFailure(null, undefined);
    for (const m of [m422, m429, m404, mNet]) expect(m.length).toBeGreaterThan(10);
    expect(new Set([m422, m429, m404, mNet]).size).toBe(4);
    expect(m429.toLowerCase()).toContain("later");
    expect(m404.toLowerCase()).toContain("save");
  });

  it("tells the author the text is untouched and never echoes raw server fields", () => {
    const m = messageForFailure(422, { code: "REFERENCE_FAILED", reason: "<img src=x onerror=alert(1)>" });
    expect(m).not.toContain("<img");
    expect(messageForFailure(500, {}).length).toBeGreaterThan(10);
  });
});

describe("POST /api/post-reference (proxy)", () => {
  const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  type Seen = { url: string; init?: RequestInit };

  async function call(bodyText: string, seen: Seen[] = []) {
    env.API = {
      fetch: async (url, init) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ token: "abc", referenceId: "r", reused: false }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const request = new Request("http://localhost/api/post-reference", {
      method: "POST",
      headers: { Origin: "http://localhost", "X-CSRF-Token": "csrf-1", Cookie: "tj_session=s1", "content-type": "application/json" },
      body: bodyText,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return POST({ request, cache: { set() {} } } as any);
  }

  it("builds /posts/<id>/references from postId, forwards cookie, Origin, CSRF, and strips postId from the body", async () => {
    const seen: Seen[] = [];
    const res = await call(JSON.stringify({ postId: ID, url: "https://example.com/a" }), seen);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ token: "abc", referenceId: "r", reused: false });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).pathname).toBe(`/posts/${ID}/references`);
    const h = new Headers(seen[0]!.init?.headers);
    expect(h.get("Cookie")).toBe("tj_session=s1");
    expect(h.get("Origin")).toBe("http://localhost");
    expect(h.get("X-CSRF-Token")).toBe("csrf-1");
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ url: "https://example.com/a" });
  });

  it("rejects a non-uuid or missing postId with 400 and never reaches the api", async () => {
    for (const postId of ["p1", "../x", "", undefined, 5]) {
      const seen: Seen[] = [];
      const res = await call(JSON.stringify({ postId, url: "https://example.com" }), seen);
      expect(res.status, String(postId)).toBe(400);
      expect(seen, String(postId)).toHaveLength(0);
    }
  });

  it("rejects malformed JSON with 400 INVALID_JSON", async () => {
    const res = await call("{nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "INVALID_JSON" });
  });
});

describe("reference-picker island (source scan)", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/scripts/reference-picker.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("posts to the same-origin proxy with the page CSRF token and never uses innerHTML", () => {
    expect(src).toContain('"/api/post-reference"');
    expect(src).toContain("X-CSRF-Token");
    expect(src).toContain("export function initReferencePicker");
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it("only writes the textarea on a success path (a failed card never loses text)", () => {
    const writes = src.match(/textarea\.value\s*=/g) ?? [];
    expect(writes).toHaveLength(1);
  });
});
