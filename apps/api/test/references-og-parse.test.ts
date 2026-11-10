// SPDX-License-Identifier: MIT OR Apache-2.0
import { SNAPSHOT_CAPS } from "@thinkersjournal/shared";
import { describe, expect, it } from "vitest";

import { parseOpenGraph } from "../src/references/og-parse";

const FINAL = "https://example.com/posts/1";

describe("parseOpenGraph: extraction", () => {
  it("extracts title, og fields, canonical and a remote image", () => {
    const html = `<!doctype html><html><head>
      <title>Plain title</title>
      <meta property="og:title" content="OG title">
      <meta property="og:description" content="A description">
      <meta property="og:site_name" content="Example Site">
      <meta property="og:image" content="/img/card.png">
      <link rel="canonical" href="/posts/1-canonical">
      </head><body>x</body></html>`;
    expect(parseOpenGraph(html, FINAL)).toEqual({
      title: "OG title",
      description: "A description",
      siteName: "Example Site",
      canonicalUrl: "https://example.com/posts/1-canonical",
      image: { storage: "remote", url: "https://example.com/img/card.png" },
    });
  });

  it("falls back to <title>, twitter:image, and tolerates case, quoting styles and entities", () => {
    const html = `<HTML><HEAD><TITLE>  Tom &amp; Jerry
      &#8212; &#x41;  </TITLE>
      <META NAME='twitter:image' CONTENT='https://cdn.example.com/a.jpg'>
      <meta property=og:description content=unquoted>
      <link REL="Shortcut Icon Canonical" href=https://example.com/c></HEAD>`;
    const got = parseOpenGraph(html, FINAL);
    expect(got.title).toBe("Tom & Jerry — A");
    expect(got.image).toEqual({ storage: "remote", url: "https://cdn.example.com/a.jpg" });
    expect(got.description).toBe("unquoted");
    expect(got.canonicalUrl).toBe("https://example.com/c");
  });

  it("the first occurrence of a field wins and og:title beats <title>", () => {
    const html = `<title>T</title><meta property="og:title" content="first"><meta property="og:title" content="second">`;
    expect(parseOpenGraph(html, FINAL).title).toBe("first");
  });

  it("returns an empty object for a page with nothing to take", () => {
    expect(parseOpenGraph("<html><body>hello</body></html>", FINAL)).toEqual({});
    expect(parseOpenGraph("", FINAL)).toEqual({});
  });

  it("output is plain text: control characters stripped, whitespace collapsed", () => {
    const html = `<meta property="og:title" content="a\u0000b\u0007c\n\n  d\t e​">`;
    expect(parseOpenGraph(html, FINAL).title).toBe("abc d e");
  });
});

describe("parseOpenGraph: images (never fetched, only validated)", () => {
  // Mutation that must fail this: keep an http: image, or skip the rule 1-2 check.
  it.each([
    "http://cdn.example.com/a.png",
    "https://10.0.0.1/a.png",
    "https://169.254.169.254/a.png",
    "https://localhost/a.png",
    "https://[::1]/a.png",
    "https://user:pw@cdn.example.com/a.png",
    "https://cdn.example.com:22/a.png",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "//10.0.0.1/a.png",
  ])("drops og:image %s", (src) => {
    const got = parseOpenGraph(`<meta property="og:image" content="${src}">`, FINAL);
    expect(got.image).toBeUndefined();
  });

  it("falls back to twitter:image when og:image is unusable", () => {
    const html = `<meta property="og:image" content="http://insecure.example.com/a.png"><meta name="twitter:image" content="https://ok.example.com/b.png">`;
    expect(parseOpenGraph(html, FINAL).image).toEqual({ storage: "remote", url: "https://ok.example.com/b.png" });
  });

  it("drops an image URL longer than the cap", () => {
    const long = `https://cdn.example.com/${"a".repeat(SNAPSHOT_CAPS.url)}`;
    expect(parseOpenGraph(`<meta property="og:image" content="${long}">`, FINAL).image).toBeUndefined();
  });
});

describe("parseOpenGraph: hostile input never throws and always caps", () => {
  // Mutation that must fail this: remove a field cap.
  it("caps title, description and site name", () => {
    const big = "x".repeat(100_000);
    const html = `<meta property="og:title" content="${big}"><meta property="og:description" content="${big}"><meta property="og:site_name" content="${big}">`;
    const got = parseOpenGraph(html, FINAL);
    expect(got.title?.length).toBe(SNAPSHOT_CAPS.title);
    expect(got.description?.length).toBe(SNAPSHOT_CAPS.description);
    expect(got.siteName?.length).toBe(SNAPSHOT_CAPS.siteName);
  });

  it("caps a huge <title> and a huge attribute near the 512 KB limit", () => {
    const huge = "y".repeat(480_000);
    expect(parseOpenGraph(`<title>${huge}</title>`, FINAL).title?.length).toBe(SNAPSHOT_CAPS.title);
    expect(parseOpenGraph(`<meta property="og:title" content="${huge}">`, FINAL).title?.length).toBe(SNAPSHOT_CAPS.title);
  });

  it("does not execute or read script/style bodies: a meta tag inside a script is not a field", () => {
    const html = `<script>document.write('<meta property="og:title" content="EVIL">')</script>
      <style>/* <meta property="og:description" content="EVIL"> */</style>
      <textarea><meta property="og:site_name" content="EVIL"></textarea>
      <!-- <meta property="og:title" content="EVIL"> -->
      <title>Real</title>`;
    const got = parseOpenGraph(html, FINAL);
    expect(got).toEqual({ title: "Real" });
  });

  it("survives deeply nested tags, many attributes, and unterminated constructs", () => {
    const nested = "<div>".repeat(60_000);
    const attrs = Array.from({ length: 5000 }, (_, i) => `a${i}=${i}`).join(" ");
    const cases = [
      `${nested}<meta property="og:title" content="deep">`,
      `<meta ${attrs} property="og:title" content="many">`,
      `<meta property="og:title" content="unterminated`,
      `<title>never closed`,
      `<!-- never closed <meta property="og:title" content="x">`,
      `<script>never closed`,
      `<meta property="og:title"`,
      "<<<<>>>><//><meta/><link><link rel>",
      "\u0000<\u0000meta\u0000property=og:title\u0000>",
    ];
    for (const html of cases) {
      expect(() => parseOpenGraph(html, FINAL)).not.toThrow();
    }
    expect(parseOpenGraph(cases[0] ?? "", FINAL).title).toBe("deep");
    expect(parseOpenGraph(cases[1] ?? "", FINAL).title).toBe("many");
  });

  // Mutation that must fail this: remove the 512 KB input bound.
  it("reads only the first 512 KB", () => {
    const pad = "<p>x</p>".repeat(70_000); // 560,000 chars
    const html = `${pad}<meta property="og:title" content="too late">`;
    expect(parseOpenGraph(html, FINAL).title).toBeUndefined();
    const early = `<meta property="og:title" content="in time">${pad}`;
    expect(parseOpenGraph(early, FINAL).title).toBe("in time");
  });

  it("runs in linear time on pathological input", () => {
    const started = Date.now();
    parseOpenGraph("<a ".repeat(170_000), FINAL);
    parseOpenGraph("<!--".repeat(120_000), FINAL);
    parseOpenGraph("<script>".repeat(60_000), FINAL);
    parseOpenGraph("<meta content='".repeat(30_000), FINAL);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("an unparsable final URL does not throw", () => {
    expect(() => parseOpenGraph(`<meta property="og:image" content="/a.png">`, "not a url")).not.toThrow();
    expect(parseOpenGraph(`<meta property="og:image" content="/a.png">`, "not a url").image).toBeUndefined();
  });
});
