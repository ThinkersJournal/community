import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../src";
import { elements, eventHandlerNames, schemeOf, tagNames, unsafeUrls } from "./dom";

/**
 * THE XSS REGRESSION CORPUS. Every payload here was verified against this exact
 * pipeline; each one is a documented way that a "no raw HTML" renderer still
 * leaks. Deleting a case is deleting the proof that a defense is still on.
 *
 * ⚠️ Payloads 1-9 exist BECAUSE remark-rehype performs ZERO URL-protocol
 * validation. Raw-HTML-off stops TAG injection and does NOTHING about URL
 * injection. rehype-sanitize is what blocks them — it is not belt-and-braces.
 * Removing `rehypeSanitize` from the pipeline MUST redden this file.
 */
const DANGEROUS_TAGS = [
  "script",
  "iframe",
  "object",
  "embed",
  "style",
  "svg",
  "math",
  "base",
  "link",
  "meta",
  "form",
];

/** Every payload must satisfy ALL of these. */
async function expectInert(markdown: string): Promise<string> {
  const html = await renderMarkdown(markdown);
  expect(unsafeUrls(html), "a URL attribute survived with a non-http(s)/mailto scheme").toEqual([]);
  expect(eventHandlerNames(html), "an event-handler attribute survived").toEqual([]);
  expect(
    tagNames(html).filter((t) => DANGEROUS_TAGS.includes(t)),
    "a scriptable/injectable element survived",
  ).toEqual([]);
  return html;
}

/**
 * The corpus is only as good as `schemeOf`. If it silently stopped recognising
 * schemes, `unsafeUrls` would return [] for EVERYTHING and all sixteen payloads
 * would "pass" while the pipeline burned. Pin the helper itself.
 */
describe("the assertion helper itself (a broken oracle passes everything)", () => {
  it.each([
    ["javascript:alert(1)", "javascript"],
    ["  javascript:alert(1)", "javascript"],
    ["JaVaScRiPt:alert(1)", "javascript"],
    ["vbscript:msgbox(1)", "vbscript"],
    ["data:text/html;base64,x", "data"],
    ["https://e.com", "https"],
    ["mailto:a@b.com", "mailto"],
    ["/about", null],
    ["#frag", null],
  ])("schemeOf(%j) === %j", (url, expected) => {
    expect(schemeOf(url)).toBe(expected);
  });

  it("flags a javascript: href as unsafe when one really is present", () => {
    // Proves unsafeUrls() can actually FAIL — i.e. the corpus's green is earned.
    expect(unsafeUrls('<a href="javascript:alert(1)">x</a>')).toEqual(["javascript:alert(1)"]);
  });

  it("does NOT flag inert text that merely CONTAINS the string", () => {
    // The exact false positive that substring assertions produce.
    expect(unsafeUrls("<a>javascript:alert(1)</a>")).toEqual([]);
    expect(eventHandlerNames('<a title="onmouseover=alert(1)">x</a>')).toEqual([]);
  });
});

describe("URL-protocol injection (remark-rehype validates NOTHING here)", () => {
  it.each([
    ["1. plain javascript:", "[x](javascript:alert(1))"],
    ["2. mixed case", "[x](JaVaScRiPt:alert(1))"],
    ["3. numeric entity", "[x](java&#115;cript:alert(1))"],
    ["4. named entity colon", "[x](javascript&colon;alert(1))"],
    ["5a. leading whitespace", "[x](  javascript:alert(1))"],
    ["5b. backslash escape", "[x](javascript\\:alert(1))"],
    ["6. REFERENCE-STYLE", "[x][ref]\n\n[ref]: javascript:alert(1)"],
    ["7. vbscript:", "[x](vbscript:msgbox(1))"],
    ["8. data:text/html image", "![](data:text/html;base64,PHN2Zy9vbmxvYWQ9YWxlcnQoMSk+)"],
    ["9. data:image/svg+xml", "![](data:image/svg+xml;base64,PHN2Zy9vbmxvYWQ9YWxlcnQoMSk+)"],
  ])("%s is blocked", async (_name, markdown) => {
    await expectInert(markdown);
  });

  it("9b. is STRICTER than markdown-it's GOOD_DATA_RE — no data: URL survives at all", async () => {
    const html = await renderMarkdown("![](data:image/png;base64,iVBORw0KGgo=)");
    // markdown-it's validateLink ALLOWS data:image/(gif|png|jpeg|webp) — even in
    // href. Our schema's `src: ['http','https']` blocks ALL data: URLs. Pinned
    // so nobody "fixes" the schema toward markdown-it's looser policy.
    expect(unsafeUrls(html)).toEqual([]);
    expect(
      elements(html)
        .filter((e) => e.tagName === "img")
        .map((e) => e.properties?.src),
    ).toEqual([undefined]);
  });
});

describe("raw HTML injection", () => {
  it.each([
    ["10a. img onerror", "<img src=x onerror=alert(1)>"],
    ["10b. script", "<script>alert(1)</script>"],
    ["11a. svg onload", "<svg onload=alert(1)></svg>"],
    ["11b. iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ["11c. style", "<style>body{background:url(javascript:alert(1))}</style>"],
    ["12. interleaved emphasis", "*<img src=x onerror=alert(1)>*"],
  ])("%s is blocked", async (_name, markdown) => {
    await expectInert(markdown);
  });

  it("13. entity smuggling stays LITERAL TEXT", async () => {
    const html = await expectInert("&lt;img src=x onerror=alert(1)&gt;");
    // The decoded text must survive as TEXT — an over-eager "fix" that strips it
    // would be a correctness bug (people write about HTML on this site).
    expect(html).toContain("&#x3C;img src=x onerror=alert(1)>");
  });

  it("14. attribute breakout in alt text does not create an attribute", async () => {
    const html = await renderMarkdown('![alt"onerror=alert(1)](https://a.com/i.png)');
    expect(eventHandlerNames(html)).toEqual([]);
    const img = elements(html).find((e) => e.tagName === "img");
    // The quote is INSIDE the alt value, escaped by the serializer — not a breakout.
    expect(img?.properties?.alt).toBe('alt"onerror=alert(1)');
    expect(img?.properties?.src).toBe("https://a.com/i.png");
  });
});

describe("15. DOM clobbering", () => {
  it("cannot clobber a footnote target", async () => {
    await expectInert('<a id="body" name="body"></a>\n\nx[^body]\n\n[^body]: note');
  });

  it("footnote links still WORK (clobber: [] is load-bearing in both directions)", async () => {
    const html = await renderMarkdown("x[^1]\n\n[^1]: note");
    const ids = elements(html)
      .map((e) => e.properties?.id)
      .filter((v): v is string => typeof v === "string");
    // remark-rehype ALREADY prefixes footnote ids with `user-content-`. Leaving
    // sanitize's `clobber` on DOUBLE-prefixes them and BREAKS EVERY FOOTNOTE
    // LINK (reproduced in both the default and clobberPrefix:'' configs). This
    // asserts the id and the href still agree.
    expect(ids.some((id) => id.startsWith("user-content-"))).toBe(true);
    const hrefs = elements(html)
      .map((e) => e.properties?.href)
      .filter((v): v is string => typeof v === "string");
    const fragments = hrefs.filter((h) => h.startsWith("#")).map((h) => h.slice(1));
    // Guard against a vacuous pass: there must BE fragment links to check.
    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments.every((f) => ids.includes(f))).toBe(true);
  });
});

describe("16. fence-language injection", () => {
  it("does not throw and produces no element from the info string", async () => {
    // ⚠️ The fence info string is ATTACKER-CONTROLLED. Here (pre-Shiki) it must
    // survive only as an escaped, inert class. Task 6 pins the other half: that
    // it cannot make Shiki THROW, which would 500 every post.
    const html = await renderMarkdown('```"><img src=x onerror=alert(1)\ncode\n```');
    expect(eventHandlerNames(html)).toEqual([]);
    expect(tagNames(html).filter((t) => t === "img")).toEqual([]);
  });
});
