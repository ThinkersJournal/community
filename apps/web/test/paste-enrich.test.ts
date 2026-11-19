// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bareUrl, replaceUrlLineWithRef } from "../src/scripts/paste-enrich";

/** M3.4c: paste-to-enrich helpers, plus a source scan of the island wiring (no DOM in this node project). */

describe("bareUrl", () => {
  it("accepts one http(s) link, trimmed", () => {
    expect(bareUrl("https://github.com/o/r")).toBe("https://github.com/o/r");
    expect(bareUrl("  http://example.com/a?b=1 \n")).toBe("http://example.com/a?b=1");
  });

  it("refuses prose, several links, other schemes and empties", () => {
    expect(bareUrl("see https://github.com/o/r")).toBeNull();
    expect(bareUrl("https://a.example https://b.example")).toBeNull();
    expect(bareUrl("https://a.example\nhttps://b.example")).toBeNull();
    expect(bareUrl("javascript:alert(1)")).toBeNull();
    expect(bareUrl("ftp://example.com/x")).toBeNull();
    expect(bareUrl("not a url")).toBeNull();
    expect(bareUrl("   ")).toBeNull();
    expect(bareUrl("")).toBeNull();
  });
});

describe("replaceUrlLineWithRef", () => {
  const url = "https://github.com/o/r";

  it("replaces the URL's own line, leaving the rest byte-identical", () => {
    expect(replaceUrlLineWithRef(`intro\n${url}\noutro`, url, "t1")).toBe("intro\n{{ref:t1}}\noutro");
  });

  it("keeps CRLF line endings", () => {
    expect(replaceUrlLineWithRef(`a\r\n${url}\r\nb`, url, "t")).toBe("a\r\n{{ref:t}}\r\nb");
  });

  it("replaces only the first matching line", () => {
    expect(replaceUrlLineWithRef(`${url}\n${url}`, url, "t")).toBe(`{{ref:t}}\n${url}`);
  });

  it("returns null when the URL is no longer alone on a line, so the caller inserts at the cursor instead", () => {
    expect(replaceUrlLineWithRef(`look at ${url} now`, url, "t")).toBeNull();
    expect(replaceUrlLineWithRef("", url, "t")).toBeNull();
  });
});

describe("island wiring", () => {
  const src = readFileSync(join(__dirname, "../src/scripts/reference-picker.ts"), "utf8");

  it("listens for paste on the editor textarea and never prevents the paste", () => {
    expect(src).toMatch(/addEventListener\("paste"/);
    expect(src).not.toMatch(/preventDefault\(\);\s*\/\/\s*paste/);
    expect(src).toMatch(/bareUrl\(/);
    expect(src).toMatch(/replaceUrlLineWithRef\(/);
  });
});
