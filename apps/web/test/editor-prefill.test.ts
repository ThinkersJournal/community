import { readFileSync } from "node:fs";
import { join } from "node:path";

import { IDEMPOTENCY_KEY_RE } from "@thinkersjournal/shared";
import { describe, expect, it } from "vitest";

import { KEY_SHAPE, parsePrefillFragment } from "../src/scripts/editor-prefill";

/**
 * The `#cr=` prefill of the create form (design 2026-10-13, section 4). The
 * fragment is untrusted input: anything malformed is ignored as a whole, except
 * a malformed KEY, which is dropped alone.
 */
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";

function frag(payload: unknown): string {
  const json = typeof payload === "string" ? payload : JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `#cr=${b64}`;
}

describe("parsePrefillFragment", () => {
  it("reads title, body, tags and key (including non-ASCII text)", () => {
    const p = parsePrefillFragment(frag({ title: "Résumé ✓", markdownSource: "# hi\n\nbody", tags: ["rust", "web-dev"], key: KEY }));
    expect(p).toEqual({ title: "Résumé ✓", markdownSource: "# hi\n\nbody", tags: ["rust", "web-dev"], key: KEY });
  });

  it("a malformed key is dropped but the rest still applies", () => {
    for (const key of ["short", "has space in it 12345", "a".repeat(65), 12345, null]) {
      expect(parsePrefillFragment(frag({ title: "t", key }))).toEqual({ title: "t" });
    }
    // Control: a good key survives.
    expect(parsePrefillFragment(frag({ title: "t", key: KEY }))).toEqual({ title: "t", key: KEY });
  });

  it("ignores anything that is not a well-formed #cr= payload", () => {
    expect(parsePrefillFragment("")).toBeNull();
    expect(parsePrefillFragment("#other=abc")).toBeNull();
    expect(parsePrefillFragment("#cr=")).toBeNull();
    expect(parsePrefillFragment("#cr=!!not-base64!!")).toBeNull();
    expect(parsePrefillFragment(frag("not json"))).toBeNull();
    expect(parsePrefillFragment(frag([1, 2]))).toBeNull();
    expect(parsePrefillFragment(frag("null"))).toBeNull();
  });

  it("rejects wrong types and over-limit values as a whole", () => {
    expect(parsePrefillFragment(frag({ title: 5 }))).toBeNull();
    expect(parsePrefillFragment(frag({ title: "x".repeat(201) }))).toBeNull();
    expect(parsePrefillFragment(frag({ markdownSource: "x".repeat(100_001) }))).toBeNull();
    expect(parsePrefillFragment(frag({ tags: ["a", "b", "c", "d", "e", "f"] }))).toBeNull();
    expect(parsePrefillFragment(frag({ tags: ["x".repeat(51)] }))).toBeNull();
    expect(parsePrefillFragment(frag({ tags: ["has,comma"] }))).toBeNull();
    expect(parsePrefillFragment(frag({ tags: "rust" }))).toBeNull();
    // Control: the limits themselves are accepted.
    expect(parsePrefillFragment(frag({ title: "x".repeat(200), tags: ["a", "b", "c", "d", "e"] }))).not.toBeNull();
  });

  it("an invalid UTF-8 payload is ignored", () => {
    expect(parsePrefillFragment("#cr=_w")).toBeNull(); // 0xFF
  });
});

describe("the browser copy of the key shape", () => {
  it("is the same regular expression as the api's (the script cannot import the shared barrel)", () => {
    expect(KEY_SHAPE.source).toBe(IDEMPOTENCY_KEY_RE.source);
    expect(KEY_SHAPE.flags).toBe(IDEMPOTENCY_KEY_RE.flags);
  });
});

describe("the island's source", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/scripts/editor-prefill.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("writes with .value and never innerHTML", () => {
    expect(src).toMatch(/\.value = /);
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });
});
