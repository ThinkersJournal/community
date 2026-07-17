/**
 * Rewrite any `language-<x>` class Shiki cannot handle to `language-text`.
 *
 * ⚠️ THIS IS A DoS GUARD, AND IT IS LOAD-BEARING — BUT NOT FOR THE OBVIOUS
 * REASON. Read this before deleting it as redundant.
 *
 * The fence info string is ATTACKER-CONTROLLED and reaches Shiki. Shiki's CORE
 * API really does throw on an unloaded language — `highlighter.codeToHast(code,
 * { lang: "zzz" })` throws ``Language `zzz` not found, you may need to load it
 * first`` (verified directly against shiki@4.3.1).
 *
 * ⚠️ HOWEVER: @shikijs/rehype@4.3.1 — the wrapper we actually call — does NOT
 * currently reach that throw. Its visitor checks
 * `getLoadedLanguages().includes(lang) || isSpecialLang(lang)` and, finding
 * neither, hits `if (!lang) return` and leaves the node untouched. So TODAY,
 * with this exact config, removing this plugin does not 500. Do not conclude
 * the guard is cargo-cult: that upstream check holds ONLY because we set
 * neither `lazy` nor `fallbackLanguage`.
 *
 * ⚠️ IT IS ONE CONFIG FLAG FROM REOPENING — verified, not hypothetical. Set
 * `lazy: true` on rehypeShikiFromHighlighter (an entirely plausible future ask:
 * "auto-load any language instead of a fixed 15") and the wrapper instead calls
 * `highlighter.loadLanguage(lang)` with the ATTACKER-CONTROLLED `lang`, whose
 * rejection it rethrows when no `fallbackLanguage`/`onError` is set. Measured
 * end-to-end through the real wrapper on our core highlighter:
 *   lazy:true, WITHOUT this plugin -> TypeError: Cannot read properties of
 *     undefined (reading 'split')  => the render rejects => 500 on every post
 *     containing that fence, forever, for everyone.
 *   lazy:true, WITH this plugin    -> renders fine.
 * (On a BUNDLED shiki highlighter the same path throws the tidier
 * ``ShikiError: Language `zzz` is not included in this bundle``; we use
 * createHighlighterCore, which has no bundled-language registry to consult, so
 * it fails as an uncaught TypeError instead. Either way: a 500.)
 * test/highlight.test.ts pins exactly this under `lazy: true`.
 *
 * So this plugin is what makes the language set a CLOSED, first-party decision
 * rather than something an upstream default happens to be protecting for us.
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
 *
 * These four mirror @shikijs/primitive@4.3.1's `isSpecialLang`, which is
 * `lang === "ansi" || isPlainLang(lang)`, where `isPlainLang` hard-codes
 * exactly `["plaintext", "txt", "text", "plain"]`. Keep this list in step with
 * that one: an entry here that Shiki does NOT treat as special would be passed
 * through unrewritten and then silently skipped (harmless, just unhighlighted);
 * a special lang MISSING here would be needlessly rewritten to `text` (also
 * harmless — same visual result). Neither direction can 500, which is why this
 * list is exactness rather than safety.
 */
const SPECIAL_LANGS = ["text", "plaintext", "txt", "plain", "ansi"] as const;

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
