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
