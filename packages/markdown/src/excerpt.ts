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
 */
export function markdownExcerpt(markdown: string, maxChars = 160): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const blocks: string[] = [];
  collectBlockText(tree, blocks);

  const text = blocks.join(" ").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
