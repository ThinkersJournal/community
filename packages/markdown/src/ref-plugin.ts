// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Replaces a paragraph made only of `{{ref:TOKEN}}` lines with reference cards (spec section 2).
 *
 * It works on the PARSED tree, which is what makes the code rules free: a token inside a code span or a fenced block is
 * a `code` element's text, never a paragraph's own text, so it is never touched. A token mid-sentence makes the
 * paragraph more than token lines, so it stays literal. A token that is not in `refs` is dropped (an unknown or removed
 * token renders nothing, never the raw text).
 *
 * ⚠️ RUNS AFTER THE SANITIZER (see render.ts), and emits a `raw` node: the card HTML comes from `renderRefCard`, which
 * escapes everything. That is why `rehypeStringify` is given `allowDangerousHtml`: the only raw nodes in the tree are
 * the ones made here, because remark-rehype drops author HTML and rehype-sanitize removes any raw node.
 */
import { SKIP, visit } from "unist-util-visit";

import { renderRefCard } from "./ref-card";

import type { RefMap } from "./ref-card";
import type { Element, ElementContent, Root } from "hast";

/** 12 characters of unpadded base32 (spec section 2). */
const TOKEN_LINE = /^\{\{ref:([A-Z2-7]{12})\}\}$/;

/** The tokens of a paragraph that holds nothing but token lines, or null if it holds anything else. */
function tokensOf(paragraph: Element): string[] | null {
  const only = paragraph.children.length === 1 ? paragraph.children[0] : undefined;
  if (only?.type !== "text") return null;
  const tokens: string[] = [];
  for (const line of only.value.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    const match = TOKEN_LINE.exec(text);
    if (match?.[1] === undefined) return null;
    tokens.push(match[1]);
  }
  return tokens.length > 0 ? tokens : null;
}

function rawNode(html: string): ElementContent {
  // `raw` is not in the standard hast types; rehype-stringify serialises it when allowDangerousHtml is set.
  return { type: "raw", value: html } as unknown as ElementContent;
}

function isRefMap(value: unknown): value is RefMap {
  return value instanceof Map;
}

/** Plugin options come from `file.data.refs` (set per render), so one memoised processor serves every call. */
export function rehypeRefCards() {
  return (tree: Root, file: { data: object }): void => {
    const refs: unknown = Reflect.get(file.data, "refs");
    if (!isRefMap(refs)) return; // refs omitted: tokens stay literal text (backward compatible)
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "p" || parent === undefined || index === undefined) return undefined;
      const tokens = tokensOf(node);
      if (tokens === null) return undefined;
      const cards = tokens.flatMap((token) => (refs.has(token) ? [rawNode(renderRefCard(refs.get(token) ?? null))] : []));
      parent.children.splice(index, 1, ...cards);
      return [SKIP, index + cards.length];
    });
  };
}
