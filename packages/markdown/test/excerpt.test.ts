import { describe, expect, it } from "vitest";

import { markdownExcerpt } from "../src";

describe("markdownExcerpt", () => {
  it("strips markup and collapses whitespace", () => {
    expect(markdownExcerpt("# Title\n\nSome **bold**  text.")).toBe("Title Some bold text.");
  });

  it("truncates with an ellipsis at the limit", () => {
    const out = markdownExcerpt("a".repeat(500), 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns TEXT, never markup — including for raw HTML input", () => {
    // The excerpt lands in an attribute and in XML; it must never carry a tag.
    expect(markdownExcerpt("<img src=x onerror=alert(1)> hi")).not.toContain("<");
  });

  it("drops INLINE raw HTML but keeps the prose around it", () => {
    // mdast keeps `<b>` as an `html` node INSIDE the paragraph, and
    // mdast-util-to-string includes its raw value by default. `includeHtml:
    // false` is what stops a tag reaching <meta name="description">.
    expect(markdownExcerpt("hello <b>x</b> world")).toBe("hello x world");
  });

  /**
   * ⚠️ mdast-util-to-string concatenates blocks with NO separator. Called on the
   * root it yields "TitleSome bold text.", "onetwo", "ab12". Each case below is
   * a verified manifestation; they are what src/excerpt.ts's tree-walk exists
   * for. A "simplification" back to a bare toString(tree) reddens all of them.
   */
  describe("separates block boundaries (toString alone runs them together)", () => {
    it.each([
      ["list items", "- one\n- two", "one two"],
      ["table cells", "| a | b |\n| - | - |\n| 1 | 2 |", "a b 1 2"],
      ["paragraph then fence", "para\n\n```js\nconst x=1;\n```", "para const x=1;"],
      ["nested blockquote", "> quoted\n\nafter", "quoted after"],
    ])("%s", (_name, markdown, expected) => {
      expect(markdownExcerpt(markdown)).toBe(expected);
    });
  });

  it("uses an image's alt text", () => {
    expect(markdownExcerpt("![alt text](https://e.com/i.png)")).toBe("alt text");
  });

  it("handles an empty document", () => {
    expect(markdownExcerpt("")).toBe("");
  });
});
