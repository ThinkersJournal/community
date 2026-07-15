/**
 * Rewrite any `language-<x>` class Shiki cannot handle to `language-text`.
 *
 * ⚠️ THIS IS A DoS GUARD. The fence info string is ATTACKER-CONTROLLED and
 * reaches Shiki, which THROWS on an unloaded language. Unguarded, ```` ```zzz ````
 * in any post 500s EVERY render of that post, forever, for everyone — the
 * cheapest denial of service on the platform.
 *
 * ⚠️ RUNS AFTER rehypeSanitize AND BEFORE Shiki. Before the sanitizer it would
 * be pointless (the class it reads is what sanitize's `/^language-./` rule
 * decides to keep); after Shiki it would be too late to prevent the throw.
 */
import { visit } from "unist-util-visit";

import type { Element, Root } from "hast";

/**
 * Shiki's built-in no-op languages. `getLoadedLanguages()` does NOT list them
 * (they never load), but Shiki accepts them — so they must be added by hand or
 * the fallback below would itself be an unloaded language.
 */
const SPECIAL_LANGS = ["text", "plaintext", "txt", "ansi"] as const;

export const FALLBACK_LANG = "text";

export interface LanguageAllowlistOptions {
  /** Typically `highlighter.getLoadedLanguages()` — names AND aliases. */
  readonly languages: readonly string[];
}

export function rehypeLanguageAllowlist(options: LanguageAllowlistOptions) {
  const allowed = new Set<string>([...options.languages, ...SPECIAL_LANGS]);

  return (tree: Root): void => {
    visit(tree, "element", (node: Element, _index, parent) => {
      if (node.tagName !== "code") return;
      if ((parent as Element | undefined)?.tagName !== "pre") return;

      const classes = node.properties?.className;
      if (!Array.isArray(classes)) return;

      node.properties!.className = classes.map((c) => {
        if (typeof c !== "string" || !c.startsWith("language-")) return c;
        const lang = c.slice("language-".length).toLowerCase();
        return allowed.has(lang) ? c : `language-${FALLBACK_LANG}`;
      });
    });
  };
}
