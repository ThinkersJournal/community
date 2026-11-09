// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.1b: the `{{ref:TOKEN}}` render (spec docs/superpowers/specs/2026-11-09-m3-connector-contract.md sections 2, 4.3, 6, 9).
 * Every test names the mutation that must turn it red. Assertions read the PARSED tree (see ./dom.ts), never a substring
 * match on markup, except where the point is that a literal is (or is not) present in the text.
 */
import { describe, expect, it } from "vitest";

import { renderMarkdown, renderRefCard } from "../src";
import { elements } from "./dom";

import type { RefCard, RefMap } from "../src";
import type { Element } from "hast";

const TOKEN = "ABCDEFGHIJKL";
const TOKEN2 = "MNOPQRSTUVWX";
const LITERAL = `{{ref:${TOKEN}}}`;

const BASE: RefCard = {
  kind: "web",
  deepLink: "https://example.com/post",
  title: "A title",
  description: "A description",
  siteName: "Example",
};

function textOf(node: Element): string {
  return node.children.map((c) => (c.type === "text" ? c.value : c.type === "element" ? textOf(c) : "")).join("");
}
const byTag = (html: string, tag: string) => elements(html).filter((e) => e.tagName === tag);
const refs = (entries: Array<[string, RefCard | null]>): RefMap => new Map(entries);

describe("renderRefCard: escapes EVERYTHING", () => {
  // Mutation that must fail: render the title (or description, siteName) unescaped.
  it("a script tag in the title is text, never an element", () => {
    const html = renderRefCard({ ...BASE, title: "<script>alert(1)</script>" });
    expect(byTag(html, "script")).toEqual([]);
    const anchor = byTag(html, "a")[0];
    expect(anchor && textOf(anchor)).toBe("<script>alert(1)</script>");
  });

  it("a script tag in the description and the site name is text too", () => {
    const html = renderRefCard({ ...BASE, description: "<img src=x onerror=alert(1)>", siteName: "<b>x</b>" });
    expect(byTag(html, "img")).toEqual([]);
    expect(byTag(html, "b")).toEqual([]);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  // Mutation that must fail: build the href without escaping the quote.
  it("a quote in the link cannot open a new attribute", () => {
    const html = renderRefCard({ ...BASE, deepLink: 'https://example.com/x" onmouseover="alert(1)' });
    for (const a of byTag(html, "a")) expect(a.properties).not.toHaveProperty("onMouseOver");
    expect(html).not.toContain('" onmouseover="');
  });

  // Mutation that must fail: drop the scheme check on deepLink.
  it.each(["javascript:alert(1)", "data:text/html,x", "vbscript:x", "//example.com/x", "/relative"])(
    "a %s link is not made into an anchor",
    (deepLink) => {
      const html = renderRefCard({ ...BASE, deepLink });
      expect(byTag(html, "a")).toEqual([]);
      expect(html).toContain("A title");
    },
  );
});

describe("renderRefCard: the card", () => {
  it("is one link to the deepLink with rel nofollow ugc noopener", () => {
    const anchors = byTag(renderRefCard(BASE), "a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.properties?.href).toBe("https://example.com/post");
    // Mutation that must fail: drop ugc / nofollow.
    expect(anchors[0]?.properties?.rel).toEqual(["nofollow", "ugc", "noopener"]);
  });

  it("shows the title, description and site name; the kind stands in for a missing site name", () => {
    const html = renderRefCard(BASE);
    expect(html).toContain("A title");
    expect(html).toContain("A description");
    expect(html).toContain("Example");
    expect(renderRefCard({ ...BASE, siteName: undefined })).toContain("web");
  });

  it("renders a complete card with no image (the card must not need one)", () => {
    const html = renderRefCard(BASE);
    expect(byTag(html, "img")).toEqual([]);
    expect(byTag(html, "a")).toHaveLength(1);
  });
});

describe("renderRefCard: the remote image (spec 4.3)", () => {
  const remote = (url: string): RefCard => ({ ...BASE, image: { storage: "remote", url, alt: "An alt" } });

  it("an https image carries no-referrer, lazy, async", () => {
    const img = byTag(renderRefCard(remote("https://img.example.com/a.png")), "img")[0];
    expect(img?.properties?.src).toBe("https://img.example.com/a.png");
    // Mutation that must fail: drop referrerpolicy (or loading, or decoding).
    expect(img?.properties?.referrerPolicy).toBe("no-referrer");
    expect(img?.properties?.loading).toBe("lazy");
    expect(img?.properties?.decoding).toBe("async");
  });

  // Mutation that must fail: allow http:, javascript: or data: through.
  it.each(["http://img.example.com/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "ftp://x/a.png", "not a url"])(
    "%s is never an img",
    (url) => {
      expect(byTag(renderRefCard(remote(url)), "img")).toEqual([]);
    },
  );

  it("a stored image (the future R2 copy) is not rendered at launch", () => {
    const card: RefCard = { ...BASE, image: { storage: "stored", key: "k", width: 1, height: 1 } };
    expect(byTag(renderRefCard(card), "img")).toEqual([]);
  });

  it("an image alt is escaped", () => {
    const img = byTag(renderRefCard({ ...BASE, image: { storage: "remote", url: "https://i.example.com/a.png", alt: '"><script>x</script>' } }), "img")[0];
    expect(img?.properties?.alt).toBe('"><script>x</script>');
  });
});

describe("renderRefCard: status and the unavailable card", () => {
  it("an unchanged card (no status) shows no status line", () => {
    expect(byTag(renderRefCard(BASE), "p").some((p) => p.properties?.className?.toString().includes("ref-card__status"))).toBe(false);
  });

  it.each([
    ["changed", "Changed since this was shared"],
    ["resolved", "Resolved since this was shared"],
  ] as const)("%s shows a text label and an as-of date", (label, text) => {
    const html = renderRefCard({ ...BASE, status: { label, asOf: "2026-11-09T10:00:00.000Z" } });
    expect(html).toContain(text);
    expect(byTag(html, "time")[0]?.properties?.dateTime).toBe("2026-11-09");
  });

  it("a garbage asOf is dropped, not echoed", () => {
    const html = renderRefCard({ ...BASE, status: { label: "changed", asOf: '"><script>' } });
    expect(byTag(html, "time")).toEqual([]);
    expect(byTag(html, "script")).toEqual([]);
  });

  it("a null card says the link is no longer available and has no link", () => {
    const html = renderRefCard(null);
    expect(html).toContain("This link is no longer available");
    expect(byTag(html, "a")).toEqual([]);
  });

  it("a gone card keeps its title and says it is no longer available", () => {
    const html = renderRefCard({ ...BASE, status: { label: "gone" } });
    expect(html).toContain("This link is no longer available");
    expect(html).toContain("A title");
  });
});

describe("renderMarkdown with refs", () => {
  it("a known token alone in its paragraph becomes the card", async () => {
    const html = await renderMarkdown(`Before\n\n${LITERAL}\n\nAfter`, { refs: refs([[TOKEN, BASE]]) });
    const anchors = byTag(html, "a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.properties?.href).toBe("https://example.com/post");
    expect(html).not.toContain("{{ref:");
    expect(html).toContain("Before");
    expect(html).toContain("After");
  });

  it("an UNKNOWN token renders nothing at all: no text, no error", async () => {
    // Mutation that must fail: leave the raw token text in place for an unknown token.
    const html = await renderMarkdown(`Before\n\n${LITERAL}\n\nAfter`, { refs: refs([]) });
    expect(html).not.toContain("ref:");
    expect(html).not.toContain("{{");
    expect(byTag(html, "a")).toEqual([]);
    expect(html).toContain("Before");
  });

  it("a known token whose card is null renders the unavailable card", async () => {
    const html = await renderMarkdown(LITERAL, { refs: refs([[TOKEN, null]]) });
    expect(html).toContain("This link is no longer available");
  });

  it("two tokens on separate lines of one paragraph are two cards", async () => {
    const html = await renderMarkdown(`{{ref:${TOKEN}}}\n{{ref:${TOKEN2}}}`, {
      refs: refs([[TOKEN, BASE], [TOKEN2, { ...BASE, title: "Second", deepLink: "https://example.com/second" }]]),
    });
    expect(byTag(html, "a").map((a) => a.properties?.href)).toEqual(["https://example.com/post", "https://example.com/second"]);
  });

  it("a token inline in a sentence stays literal text", async () => {
    // Mutation that must fail: replace the token wherever it appears, not only when alone.
    const html = await renderMarkdown(`see ${LITERAL} here`, { refs: refs([[TOKEN, BASE]]) });
    expect(byTag(html, "a")).toEqual([]);
    expect(html).toContain(LITERAL);
  });

  it("a token in a code span is literal", async () => {
    // Mutation that must fail: expand tokens before markdown parsing (a text-level replace).
    const html = await renderMarkdown(`Write \`${LITERAL}\` to embed.`, { refs: refs([[TOKEN, BASE]]) });
    expect(byTag(html, "a")).toEqual([]);
    expect(byTag(html, "code")[0] && textOf(byTag(html, "code")[0] as Element)).toBe(LITERAL);
  });

  it("a token in a fenced block is literal", async () => {
    const html = await renderMarkdown("```\n" + LITERAL + "\n```", { refs: refs([[TOKEN, BASE]]) });
    expect(byTag(html, "a")).toEqual([]);
    expect(html).toContain("ref:");
  });

  it.each([["lowercase", "{{ref:abcdefghijkl}}"], ["11 chars", "{{ref:ABCDEFGHIJK}}"], ["13 chars", "{{ref:ABCDEFGHIJKLM}}"], ["digit 1", "{{ref:ABCDEFGHIJK1}}"], ["padded", "{{ref:ABCDEFGH====}}"]])(
    "a malformed token (%s) is not a token",
    async (_name, literal) => {
      // Mutation that must fail: loosen the token pattern.
      const html = await renderMarkdown(literal, { refs: refs([[TOKEN, BASE]]) });
      expect(byTag(html, "a")).toEqual([]);
      expect(html).toContain(literal);
    },
  );

  it("refs omitted: the token stays literal (render is backward compatible)", async () => {
    const html = await renderMarkdown(LITERAL);
    expect(byTag(html, "a")).toEqual([]);
    expect(html).toContain(LITERAL);
  });

  it("a hostile title cannot put a script in the rendered post", async () => {
    // Mutation that must fail: render the title unescaped.
    const html = await renderMarkdown(LITERAL, { refs: refs([[TOKEN, { ...BASE, title: "<script>alert(1)</script>" }]]) });
    expect(byTag(html, "script")).toEqual([]);
  });

  it("the card is added AFTER the sanitizer: its own rel and attributes survive", async () => {
    const html = await renderMarkdown(LITERAL, { refs: refs([[TOKEN, { ...BASE, image: { storage: "remote", url: "https://i.example.com/a.png" } }]]) });
    expect(byTag(html, "a")[0]?.properties?.rel).toEqual(["nofollow", "ugc", "noopener"]);
    expect(byTag(html, "img")[0]?.properties?.referrerPolicy).toBe("no-referrer");
  });
});
