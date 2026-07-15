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

  /**
   * ⚠️ THE EXCERPT IS DESTINED FOR RSS/ATOM. XML 1.0 forbids unpaired
   * surrogates and they cannot be encoded as valid UTF-8, so a lone surrogate
   * makes the serializer throw or emit U+FFFD and a feed reader rejects the
   * ENTIRE DOCUMENT — every item, not just this one.
   *
   * `String.prototype.slice` cuts UTF-16 CODE UNITS, so slicing mid-emoji
   * leaves a lone high surrogate that `.trimEnd()` does NOT remove. The trigger
   * is ordinary content: any emoji straddling the boundary. So truncation cuts
   * on CODE POINTS, and `maxChars` is counted in code points.
   */
  describe("truncation is code-point safe (a lone surrogate breaks the WHOLE feed)", () => {
    /** Every unpaired surrogate in `s` — must always be empty. */
    const loneSurrogates = (s: string): string[] => {
      const out: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        const isHigh = code >= 0xd800 && code <= 0xdbff;
        const isLow = code >= 0xdc00 && code <= 0xdfff;
        if (!isHigh && !isLow) continue;
        const next = s.charCodeAt(i + 1);
        const paired = isHigh && next >= 0xdc00 && next <= 0xdfff;
        if (paired) i++;
        else out.push(`U+${code.toString(16).toUpperCase()}@${i}`);
      }
      return out;
    };

    it("never emits a lone surrogate when cutting through an emoji", () => {
      const out = markdownExcerpt("😀".repeat(50), 10);
      expect(loneSurrogates(out), `lone surrogate in ${JSON.stringify(out)}`).toEqual([]);
      expect(out.endsWith("…")).toBe(true);
      // 9 whole emoji + the ellipsis = 10 CODE POINTS (not 10 UTF-16 units).
      expect([...out]).toHaveLength(10);
    });

    it("counts maxChars in code points for non-BMP text", () => {
      // 5 emoji is 5 code points but 10 UTF-16 units; under a limit of 8 code
      // points it fits whole and must NOT be truncated.
      const out = markdownExcerpt("😀".repeat(5), 8);
      expect(out).toBe("😀".repeat(5));
      expect(loneSurrogates(out)).toEqual([]);
    });

    it("the helper itself detects a real lone surrogate (the oracle can fail)", () => {
      expect(loneSurrogates("ab\ud83dcd")).toEqual(["U+D83D@2"]);
      expect(loneSurrogates("😀")).toEqual([]);
    });
  });

  /**
   * `maxChars` is public API taking a number, and a realistic caller computes it
   * (`160 - title.length`), which reaches <= 0. `slice(0, -1)` would drop only
   * the LAST character and return nearly the whole document into a <meta> tag.
   */
  describe("degenerate maxChars", () => {
    it("returns empty for maxChars <= 0 rather than the whole document", () => {
      expect(markdownExcerpt("word ".repeat(100), 0)).toBe("");
      expect(markdownExcerpt("word ".repeat(100), -5)).toBe("");
    });

    it("returns just the ellipsis for maxChars === 1", () => {
      expect(markdownExcerpt("word ".repeat(100), 1)).toBe("…");
    });

    it("never exceeds maxChars code points", () => {
      for (const n of [1, 2, 3, 5, 20]) {
        expect([...markdownExcerpt("word ".repeat(100), n)].length).toBeLessThanOrEqual(n);
      }
    });
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
