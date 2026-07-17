/**
 * ⚠️ ASSERT ON THE PARSED TREE, NEVER A SUBSTRING.
 *
 * `expect(html).not.toContain("javascript:")` produces FALSE POSITIVES that
 * train people to ignore this suite:
 *   • `<a>javascript:alert(1)</a>` — href stripped, inert TEXT — "contains" it;
 *   • `title="onmouseover=alert(1)"` — quoted, inert — "contains" it.
 * Both are perfectly safe. So the output is re-parsed with a real HTML parser
 * and the assertions read ATTRIBUTES off the resulting tree.
 *
 * rehype-parse (hast, spec-compliant) is a devDependency: it parses the
 * pipeline's OUTPUT in tests only and never ships to workerd, so the DOMPurify
 * "no DOM in workerd" objection does not apply to it.
 */
import rehypeParse from "rehype-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import type { Element, Root } from "hast";

export function elements(html: string): Element[] {
  const tree = unified().use(rehypeParse, { fragment: true }).parse(html) as Root;
  const found: Element[] = [];
  visit(tree, "element", (node: Element) => {
    found.push(node);
  });
  return found;
}

export function tagNames(html: string): string[] {
  return elements(html).map((el) => el.tagName);
}

/** hast property names for every attribute that can carry a URL. */
const URL_PROPERTIES = [
  "href",
  "src",
  "cite",
  "longDesc",
  "srcSet",
  "action",
  "formAction",
  "poster",
] as const;

/**
 * Every URL-bearing attribute value in the output.
 *
 * `value` is typed `unknown` deliberately. @types/hast declares all eight of the
 * properties above as `string | undefined`, which would make the array branch
 * provably dead code (tsc: "Property 'map' does not exist on type 'never'") —
 * but hast splits some comma-separated properties into ARRAYS at runtime, and a
 * type-driven `string`-only read would silently skip such a value. Verified
 * against rehype-parse: `srcSet` currently comes back as a STRING, so the array
 * branch is belt-and-braces against a hast change, not a live path today.
 */
export function urlValues(html: string): string[] {
  return elements(html).flatMap((el) =>
    URL_PROPERTIES.flatMap((k) => {
      const value: unknown = el.properties?.[k];
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value.map(String);
      return [];
    }),
  );
}

/**
 * Every `on*` attribute surviving in the output. hast maps `onerror` to the
 * camelCase `onError` via property-information, so match case-insensitively.
 */
export function eventHandlerNames(html: string): string[] {
  return elements(html).flatMap((el) =>
    Object.keys(el.properties ?? {}).filter((k) => k.toLowerCase().startsWith("on")),
  );
}

/**
 * The URL scheme, lowercased, or null for a relative/fragment URL.
 *
 * Leading whitespace AND C0 control characters (U+0000–U+0020) are skipped
 * BEFORE matching, because browsers strip them when resolving a URL: both
 * " javascript:x" and a U+0001-prefixed "javascript:x" navigate. Anchoring
 * strictly at `^[a-z]` would return null — "relative", i.e. treated as SAFE —
 * for exactly the payloads that are not. This helper must never be more
 * permissive than a browser.
 */
export function schemeOf(url: string): string | null {
  const match = /^[\s\u0000-\u0020]*([a-z][a-z0-9+.-]*):/i.exec(url);
  return match === null ? null : match[1]!.toLowerCase();
}

/** null (relative) plus exactly the schemes our schema permits. */
const SAFE_SCHEMES: ReadonlySet<string | null> = new Set([null, "http", "https", "mailto"]);

export function unsafeUrls(html: string): string[] {
  return urlValues(html).filter((u) => !SAFE_SCHEMES.has(schemeOf(u)));
}
