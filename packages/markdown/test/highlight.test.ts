import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../src";
import { HIGHLIGHT_LANGS } from "../src/highlight";
import { elements, eventHandlerNames, tagNames } from "./dom";

describe("syntax highlighting", () => {
  it("highlights an allowlisted language", async () => {
    const html = await renderMarkdown("```typescript\nconst x: number = 1;\n```");
    const styled = elements(html).filter((e) => typeof e.properties?.style === "string");
    // Shiki's output is per-token spans carrying inline colours. No spans means
    // Shiki did not run — most likely it was placed BEFORE rehypeSanitize, whose
    // defaultSchema allows no `style` and silently strips every one of them.
    expect(styled.length).toBeGreaterThan(0);
  });

  it("renders a plain fence with no language", async () => {
    const html = await renderMarkdown("```\nplain\n```");
    expect(tagNames(html)).toContain("pre");
  });
});

describe("the language allowlist (a DoS guard, not tidiness)", () => {
  it.each([
    ["an unknown language", "```definitely-not-a-language\nx\n```"],
    ["16. the fence-language XSS payload", '```"><img src=x onerror=alert(1)\nx\n```'],
    ["an absurdly long info string", "```" + "a".repeat(5000) + "\nx\n```"],
  ])("%s does NOT throw", async (_name, markdown) => {
    // ⚠️ Shiki THROWS on an unloaded language. Unguarded, one fence 500s EVERY
    // render of that post — a permanent, one-character DoS by any author.
    await expect(renderMarkdown(markdown)).resolves.toBeTypeOf("string");
  });

  it("falls back to plain text without inventing markup", async () => {
    const html = await renderMarkdown('```"><img src=x onerror=alert(1)\nx\n```');
    expect(tagNames(html)).toContain("pre");
    expect(tagNames(html).filter((t) => t === "img")).toEqual([]);
    expect(eventHandlerNames(html)).toEqual([]);
  });

  it("every advertised language actually loads", async () => {
    // A typo in HIGHLIGHT_LANGS would silently demote a real language to `text`.
    for (const lang of HIGHLIGHT_LANGS) {
      const html = await renderMarkdown(`\`\`\`${lang}\nx\n\`\`\``);
      expect(
        elements(html).some((e) => typeof e.properties?.style === "string"),
        `\`${lang}\` is advertised in HIGHLIGHT_LANGS but rendered unhighlighted — the import in src/highlight.ts is missing or misspelled.`,
      ).toBe(true);
    }
  });

  /**
   * ⚠️ WHY THIS TEST EXISTS (not just "does not throw"): @shikijs/rehype@4.3.1's
   * OWN wrapper contains an internal
   * `highlighter.getLoadedLanguages().includes(lang) || isSpecialLang(lang)`
   * check that ALSO happens to prevent the throw for an unrecognized language
   * by default (no `lazy`/`fallbackLanguage` option configured) — verified by
   * calling `highlighter.codeToHast()` directly, which DOES throw
   * ("Language `X` not found, you may need to load it first"), proving the
   * CORE Shiki API is exactly as dangerous as documented. Because of the
   * rehype wrapper's redundant guard, the "does NOT throw" tests above pass
   * whether or not `rehypeLanguageAllowlist` is wired into the pipeline, so
   * they alone cannot prove OUR guard ran. This test asserts the allowlist's
   * actual, OBSERVABLE effect: it rewrites the unrecognized class to
   * `language-text` BEFORE Shiki runs, so Shiki still highlights the block
   * (its `shiki` wrapper class + inline token styles) instead of leaving it
   * as raw, unhighlighted markup with the attacker/typo-controlled class name
   * sitting untouched in the DOM. This is what actually reddens if the
   * allowlist plugin is removed from the pipeline.
   */
  it("routes an unrecognized language through Shiki's text fallback (proves the allowlist ran)", async () => {
    const html = await renderMarkdown("```definitely-not-a-language\nconst x = 1;\n```");
    const pre = elements(html).find((e) => e.tagName === "pre");
    expect(
      pre?.properties?.className,
      "the <pre> was not routed through Shiki at all — the allowlist did not rewrite the class before Shiki ran",
    ).toContain("shiki");
    expect(
      elements(html).some((e) => typeof e.properties?.style === "string"),
      "no highlighted spans — the unknown-language class reached Shiki unrewritten",
    ).toBe(true);
  });
});
