import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { Nodes } from "mdast";

/**
 * Leaf blocks — the nodes whose text must not be run together with the NEXT
 * block's text.
 *
 * ⚠️ `mdast-util-to-string` concatenates with NO separator, so calling it on the
 * root yields "TitleSome bold text." for "# Title\n\nSome **bold** text.", and
 * likewise "onetwo" for a two-item list, "ab12" for a table and
 * "paraconst x=1;" for a paragraph followed by a fence. All four are verified
 * (test/excerpt.test.ts pins them). So the tree is walked and each leaf block is
 * stringified separately, then joined with a space.
 *
 * Everything not listed here is a CONTAINER (root, blockquote, list, listItem,
 * table, tableRow, footnoteDefinition, …) and is recursed into, so a leaf block
 * at any depth is still found.
 */
const LEAF_BLOCKS: ReadonlySet<string> = new Set(["heading", "paragraph", "code", "tableCell"]);

function isNode(value: unknown): value is { type: string; children?: unknown[] } {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function collectBlockText(node: unknown, out: string[]): void {
  if (!isNode(node)) return;

  // ⚠️ Raw HTML is NEVER text. mdast keeps `<img src=x onerror=alert(1)>` as an
  // `html` node, and toString() includes its raw value BY DEFAULT — which would
  // put a live-looking tag into <meta name="description">. Dropped here, and
  // `includeHtml: false` below drops INLINE html inside a leaf block too.
  if (node.type === "html") return;

  if (LEAF_BLOCKS.has(node.type)) {
    const text = toString(node as Nodes, { includeHtml: false });
    if (text !== "") out.push(text);
    return;
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) collectBlockText(child, out);
  }
}

/**
 * Plain TEXT for `<meta name="description">`, OG, and RSS — never HTML.
 *
 * Derived from the mdast, not from the rendered HTML: there is no markup to
 * strip and therefore no stripping to get wrong. The result goes into an
 * attribute (Astro escapes it) or into XML (escaped by apps/web/src/lib/xml.ts).
 *
 * `remarkGfm` is applied so the mdast matches what renderMarkdown() parses —
 * without it a GFM table is parsed as paragraphs of pipe characters and the
 * excerpt would read "| a | b |" instead of "a b".
 *
 * `maxChars` counts CODE POINTS, not UTF-16 code units — see the truncation
 * note below. Returns "" for maxChars <= 0 (nothing fits).
 *
 * ⚠️ Returns TEXT, not escaped markup: escaping is the embedding page's job
 * (Astro escapes attributes; RSS/Atom must escape it as XML).
 */
export function markdownExcerpt(markdown: string, maxChars = 160): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const blocks: string[] = [];
  collectBlockText(tree, blocks);

  const text = blocks.join(" ").replace(/\s+/g, " ").trim();

  // ⚠️ `maxChars` is public API taking a number, and a realistic caller computes
  // it (`160 - title.length`), which reaches <= 0. Without this guard the
  // `maxChars - 1` below becomes `slice(0, -1)`, which drops only the LAST
  // character and returns nearly the WHOLE document into a <meta> tag.
  if (maxChars <= 0) return "";

  // ⚠️ ITERATE CODE POINTS, NEVER slice() CODE UNITS.
  //
  // `text.slice()` cuts UTF-16 code units, so cutting through an emoji leaves a
  // LONE HIGH SURROGATE (and `.trimEnd()` does not remove it). This excerpt goes
  // into RSS/Atom, and XML 1.0 forbids unpaired surrogates — they cannot be
  // encoded as valid UTF-8, so the serializer throws or emits U+FFFD and a feed
  // reader rejects the ENTIRE DOCUMENT, every item, not just this one. The
  // trigger is ordinary content: any emoji straddling the boundary.
  //
  // Cutting on code points cannot split a surrogate pair. It can still split a
  // multi-code-point GRAPHEME (a ZWJ emoji, a flag), which merely looks odd —
  // every code point remains valid XML, so the feed stays well-formed.
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars - 1).join("").trimEnd()}…`;
}
