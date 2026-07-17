import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../src";
import { elements } from "./dom";

describe("rehype-external-links runs AFTER sanitize (and is why it works at all)", () => {
  it("decorates an external link with rel + target", async () => {
    const html = await renderMarkdown("[e](https://e.com)");
    const a = elements(html).find((el) => el.tagName === "a");
    // defaultSchema allows NO rel and NO target. If these are missing, the
    // plugin has been moved BEFORE rehypeSanitize and is being stripped.
    expect(a?.properties?.rel).toEqual(["nofollow", "ugc", "noopener", "noreferrer"]);
    expect(a?.properties?.target).toBe("_blank");
  });

  it("leaves relative and mailto: links alone", async () => {
    const relative = elements(await renderMarkdown("[r](/about)")).find((e) => e.tagName === "a");
    expect(relative?.properties?.href).toBe("/about");
    expect(relative?.properties?.target).toBeUndefined();
    const mail = elements(await renderMarkdown("[m](mailto:a@b.com)")).find((e) => e.tagName === "a");
    expect(mail?.properties?.href).toBe("mailto:a@b.com");
  });
});

/**
 * ⚠️ hast-util-sanitize compares protocols CASE-SENSITIVELY
 * (`colon === protocol.length && url.slice(0, protocol.length) === protocol`,
 * lib/index.js). URL schemes are case-INSENSITIVE per RFC 3986, so
 * `HTTPS://example.com` is valid user input that would have its href silently
 * STRIPPED — fails closed (not a security bug) but is silent DATA LOSS on a
 * cached, mass-served surface.
 *
 * Fixed by normalizing the scheme to lowercase BEFORE the sanitizer. Adding
 * "HTTPS" to the protocols array would only fix the all-caps spelling and not
 * `HttP`, and would widen the allowlist — the wrong direction on this surface.
 */
describe("scheme case-insensitivity (RFC 3986) — no silent data loss", () => {
  it.each([
    ["all-caps https", "[x](HTTPS://example.com/a)", "https://example.com/a"],
    ["mixed-case http", "[x](HttP://example.com/a)", "http://example.com/a"],
    ["all-caps mailto", "[x](MAILTO:a@b.com)", "mailto:a@b.com"],
    ["mixed-case mailto", "[x](MailTo:a@b.com)", "mailto:a@b.com"],
    ["already lowercase is untouched", "[x](https://example.com/a)", "https://example.com/a"],
  ])("%s keeps its href", async (_name, markdown, expected) => {
    const a = elements(await renderMarkdown(markdown)).find((e) => e.tagName === "a");
    expect(a?.properties?.href).toBe(expected);
  });

  it("only the SCHEME is lowercased — the path keeps its case", async () => {
    const a = elements(await renderMarkdown("[x](HTTPS://Example.COM/A/PathCase?Q=V#Frag)")).find(
      (e) => e.tagName === "a",
    );
    expect(a?.properties?.href).toBe("https://Example.COM/A/PathCase?Q=V#Frag");
  });

  it("uppercase image src survives too", async () => {
    const img = elements(await renderMarkdown("![a](HTTPS://cdn.example/i.webp)")).find(
      (e) => e.tagName === "img",
    );
    expect(img?.properties?.src).toBe("https://cdn.example/i.webp");
  });

  it("a normalized external link still gets rel/target (normalizer runs BEFORE sanitize)", async () => {
    const a = elements(await renderMarkdown("[x](HTTPS://e.com)")).find((e) => e.tagName === "a");
    expect(a?.properties?.rel).toEqual(["nofollow", "ugc", "noopener", "noreferrer"]);
  });

  it("does NOT rewrite a relative URL that merely contains a colon", async () => {
    // The sanitizer treats a colon after `/`, `?` or `#` as NOT a protocol.
    // The normalizer must use the same rule or the two disagree.
    const a = elements(await renderMarkdown("[x](/a/b:c)")).find((e) => e.tagName === "a");
    expect(a?.properties?.href).toBe("/a/b:c");
  });
});

describe("GFM", () => {
  it("renders tables", async () => {
    const html = await renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(elements(html).map((e) => e.tagName)).toContain("table");
  });

  it("renders tasklists WITH the checkbox (input must stay in tagNames)", async () => {
    const html = await renderMarkdown("- [x] done");
    const input = elements(html).find((e) => e.tagName === "input");
    // defaultSchema.required pins these two, which is what makes `input` safe.
    expect(input?.properties?.type).toBe("checkbox");
    expect(input?.properties?.disabled).toBe(true);
  });

  it("renders strikethrough and autolinks", async () => {
    expect(elements(await renderMarkdown("~~x~~")).map((e) => e.tagName)).toContain("del");
    const auto = elements(await renderMarkdown("https://e.com")).find((e) => e.tagName === "a");
    expect(auto?.properties?.href).toBe("https://e.com");
  });
});

describe("images", () => {
  it("keeps an https image", async () => {
    const img = elements(await renderMarkdown("![a](https://cdn.example/i.webp)")).find(
      (e) => e.tagName === "img",
    );
    expect(img?.properties?.src).toBe("https://cdn.example/i.webp");
    expect(img?.properties?.alt).toBe("a");
  });
});

describe("ordinary prose survives (the sanitizer must not just delete everything)", () => {
  it("keeps headings, emphasis, lists, code and blockquotes", async () => {
    const html = await renderMarkdown(
      "# H\n\nSome **bold** and *em* text.\n\n- one\n- two\n\n> quote\n\n`code`",
    );
    const tags = elements(html).map((e) => e.tagName);
    for (const tag of ["h1", "strong", "em", "ul", "li", "blockquote", "code"]) {
      expect(tags, `<${tag}> was stripped`).toContain(tag);
    }
  });
});

describe("PIPELINE_VERSION", () => {
  it("is a non-empty string (it is part of the edge cache key)", async () => {
    const { PIPELINE_VERSION } = await import("../src");
    expect(PIPELINE_VERSION).toMatch(/^v\d+$/);
  });
});
