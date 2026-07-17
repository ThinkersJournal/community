/**
 * THE MARKDOWN RENDER PIPELINE — the highest-risk surface in the platform.
 * User-authored Markdown, rendered in workerd (NO DOM), EDGE-CACHED, and
 * mass-served: an XSS here is a stored, cached, mass-distributed XSS.
 *
 * ⚠️ "NO RAW HTML" IS NOT SUFFICIENT. remark-rehype performs ZERO URL-protocol
 * validation — it drops raw HTML while happily emitting href="javascript:...",
 * href="java&#115;cript:...", href="vbscript:..." and src="data:text/html;...".
 * Raw-HTML-off stops TAG injection and does nothing about URL injection.
 * rehype-sanitize is LOAD-BEARING, not defense-in-depth. test/xss.test.ts pins
 * all sixteen verified payloads; removing the sanitizer reddens it immediately.
 *
 * ⚠️ NEVER ADD rehype-raw. It is the only reason we would need an HTML parser,
 * and it re-opens everything — including invalidating the `clobber: []` premise
 * below, which rests entirely on raw HTML being off.
 *
 * ⚠️ NEVER SWAP IN DOMPurify (+ any DOM shim). Its source reads
 * `if (!DOMPurify.isSupported) { return dirty; }` — an imperfect shim makes
 * sanitize() return ATTACKER HTML UNMODIFIED, with no throw and no warning
 * (cloudflare/workerd#5752, open since 2025-12). A sanitizer whose failure mode
 * is "silently become a pass-through" is disqualifying on this surface.
 * HTMLRewriter is not a sanitizer (per Cloudflare's own maintainer).
 */
import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import rehypeExternalLinks from "rehype-external-links";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import { getHighlighter, HIGHLIGHT_THEME } from "./highlight";
import { rehypeLanguageAllowlist } from "./lang-allowlist";

import type { Element, Root } from "hast";
import type { HighlighterCore } from "shiki/core";

/**
 * ⚠️ BUMP THIS AND EVERY CACHED RENDER IS INVALIDATED ON DEPLOY.
 *
 * This is why rendering happens at READ time. The alternative — storing HTML —
 * would make a schema tightening or a rehype-sanitize CVE patch a BACKFILL OF
 * EVERY ROW. Here it is a deploy, plus this one character. It is part of the
 * edge cache key (apps/web/src/lib/cache.ts); bump it whenever the pipeline's
 * OUTPUT changes for the same input.
 */
export const PIPELINE_VERSION = "v1";

/**
 * ⚠️ defaultSchema IS NOT OUR POLICY. Every override below is load-bearing.
 *
 * Exported for test/xss.test.ts, which feeds attributes DIRECTLY into it to pin
 * the half of the boundary we do NOT own: `attributes` is inherited wholesale
 * from `defaultSchema`, and rehype-sanitize@6.0.0 depends on
 * `hast-util-sanitize: "^5.0.0"` — a CARET. A future 5.x that widened
 * `attributes['*']` would be inherited silently. It is deliberately NOT
 * re-exported from src/index.ts: it is a test seam, not public API.
 */
export const SANITIZE_SCHEMA: typeof defaultSchema = {
  ...defaultSchema,

  // ⚠️ MUST be [] — and it is correct ONLY because raw HTML is off. remark-rehype
  // already prefixes footnote ids with `user-content-`, and raw HTML is dropped,
  // so no attacker-controlled id/name can reach the tree in the first place.
  // Leaving sanitize's clobber ON therefore DOUBLE-prefixes ids and BREAKS EVERY
  // FOOTNOTE LINK (reproduced in both the default and clobberPrefix:'' configs).
  // ⚠️ If rehype-raw is ever enabled, restore `clobber` AND re-audit this entire
  // file — that one flag invalidates the premise this whole config rests on.
  clobber: [],

  protocols: {
    ...defaultSchema.protocols,
    // defaultSchema ALSO allows irc/ircs/xmpp on href. Dropped: we have no use
    // for them and every extra scheme is a handler we have not thought about.
    href: ["http", "https", "mailto"],
    // Blocks ALL data: URLs — including data:image/*, which markdown-it's
    // GOOD_DATA_RE permits. We are deliberately stricter.
    src: ["http", "https"],
    cite: ["http", "https"],
    longDesc: ["http", "https"],
  },

  // Markdown cannot produce these; belt-and-braces. `srcSet` is NOT
  // protocol-checked by defaultSchema — moot once source/picture are gone.
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => !["picture", "source"].includes(t)),
};
// Do NOT drop `input`: GFM tasklists need it, and defaultSchema.required pins it
// to { disabled: true, type: 'checkbox' }, which is safe.

/**
 * The URL-bearing properties our schema protocol-checks. Kept in lockstep with
 * `SANITIZE_SCHEMA.protocols` above — normalizing a property the sanitizer does
 * not check would be pointless; missing one it does check reintroduces the data
 * loss this plugin exists to fix.
 */
const NORMALIZED_URL_PROPERTIES = ["href", "src", "cite", "longDesc"] as const;

/** Exactly the schemes SANITIZE_SCHEMA allows, lowercase. */
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * Lowercase a URL's scheme — and ONLY when it already names an allowed scheme.
 *
 * ⚠️ THIS RUNS ON THE UNSAFE SIDE OF THE SANITIZER, so it is written to be
 * provably incapable of widening the allowlist: it rewrites a URL only if the
 * scheme case-insensitively equals http/https/mailto, and is the IDENTITY for
 * everything else. `JaVaScRiPt:` is not touched at all — no dangerous scheme can
 * lowercase INTO {http, https, mailto}, so this cannot turn a blocked URL into
 * an allowed one. test/xss.test.ts pins the uppercase dangerous schemes.
 *
 * ⚠️ The scheme is parsed EXACTLY as hast-util-sanitize parses it
 * (lib/index.js `safeProtocol`): the FIRST colon, and only if no `/`, `?` or `#`
 * appears before it. Any divergence here would be a parser differential between
 * this plugin and the sanitizer — the exact class of bug the unified/AST design
 * exists to avoid. Note it does NOT trim whitespace, deliberately: the sanitizer
 * does not either, so "  https://x" stays stripped rather than being resurrected
 * by a rule the sanitizer does not share.
 */
function lowercaseScheme(url: string): string {
  const colon = url.indexOf(":");
  if (colon < 0) return url;

  const slash = url.indexOf("/");
  const questionMark = url.indexOf("?");
  const numberSign = url.indexOf("#");
  // A colon after `/`, `?` or `#` is not a scheme (e.g. "/a/b:c").
  if (slash > -1 && colon > slash) return url;
  if (questionMark > -1 && colon > questionMark) return url;
  if (numberSign > -1 && colon > numberSign) return url;

  const scheme = url.slice(0, colon);
  const lower = scheme.toLowerCase();
  if (scheme === lower || !ALLOWED_SCHEMES.has(lower)) return url;
  return lower + url.slice(colon);
}

/**
 * ⚠️ WHY THIS EXISTS: hast-util-sanitize compares protocols CASE-SENSITIVELY
 * (`url.slice(0, protocol.length) === protocol`), but RFC 3986 makes schemes
 * case-INSENSITIVE. So `[x](HTTPS://example.com)` — valid user input — had its
 * href silently STRIPPED. It failed closed, so it was never a security bug, but
 * it was silent DATA LOSS on a cached, mass-served surface.
 *
 * Fixed HERE rather than by adding "HTTPS" to the protocols array, because that
 * would only fix the all-caps spelling (not `HttP`) and would WIDEN the
 * allowlist — the wrong direction on this surface.
 */
function rehypeLowercaseUrlScheme() {
  return (tree: Root): void => {
    visit(tree, "element", (node: Element) => {
      for (const property of NORMALIZED_URL_PROPERTIES) {
        const value = node.properties[property];
        if (typeof value === "string") {
          node.properties[property] = lowercaseScheme(value);
        }
      }
    });
  };
}

function buildRenderer(highlighter: HighlighterCore) {
  return (
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      // allowDangerousHtml is false by DEFAULT => raw HTML is dropped here.
      .use(remarkRehype)
      // Normalizes ONLY the case of an already-allowed scheme (HTTPS: -> https:)
      // so the sanitizer's case-SENSITIVE protocol check does not silently drop
      // valid user links. Runs BEFORE the sanitizer by necessity — it exists to
      // change what the sanitizer sees — and is provably unable to widen the
      // allowlist. See lowercaseScheme() above.
      .use(rehypeLowercaseUrlScheme)
      // ─────────────────────────────────────────────────────────────────────
      // ⚠️ THE LAST UNSAFE THING IS ABOVE THIS LINE.
      .use(rehypeSanitize, SANITIZE_SCHEMA)
      // Everything below is trusted, app-generated, and MUST run AFTER sanitize.
      // ORDERING IS NOT COSMETIC: defaultSchema allows NO `rel`, NO `target` and
      // NO `style` on any element, so running these BEFORE the sanitizer would
      // silently STRIP exactly what they add. rehype's own rule: "use
      // rehype-sanitize after the last unsafe thing."
      // ─────────────────────────────────────────────────────────────────────
      .use(rehypeExternalLinks, {
        rel: ["nofollow", "ugc", "noopener", "noreferrer"],
        target: "_blank",
        protocols: ["http", "https"],
      })
      // ⚠️ ORDER: allowlist THEN Shiki. The allowlist reads the class the
      // sanitizer decided to keep, and must run before Shiki acts on it.
      // ⚠️ DO NOT set `lazy: true` or `fallbackLanguage` on the Shiki plugin
      // below without reading src/lang-allowlist.ts's header first: those flags
      // are exactly what turns an attacker-controlled fence info string back
      // into a throw — i.e. a 500 on every render of that post. The allowlist
      // is what keeps that closed; it is verified load-bearing under lazy:true.
      .use(rehypeLanguageAllowlist, { languages: highlighter.getLoadedLanguages() })
      // ⚠️ AFTER rehypeSanitize, non-negotiably: defaultSchema allows no `style`,
      // so a sanitizer running after this would strip every token colour. Safe
      // because Shiki emits HAST — it never round-trips through a string parser.
      .use(rehypeShikiFromHighlighter, highlighter, { theme: HIGHLIGHT_THEME })
      // M3 inserts the ref-card plugin here.
      .use(rehypeStringify)
  );
}

/**
 * Memoized because Task 6 makes construction genuinely async (Shiki's
 * highlighter init). Declared async NOW so that task adds a step rather than
 * changing this module's signature and every call site with it.
 *
 * ⚠️ DOES NOT CACHE A REJECTED INIT — two layers deep. `rendererPromise ??= x`
 * stores the PROMISE OBJECT synchronously, before it settles; a naive version
 * of this would memoize a transient failure for the isolate's lifetime and
 * every render would 500 forever (this is exactly the bug M0 hit with
 * argon2's memoized WASM init). getHighlighter() already resets ITS OWN memo
 * on rejection (src/highlight.ts) — but that alone is not enough, because
 * `rendererPromise` here would still hold the outer, now-rejected
 * buildRendererAsync() promise even after getHighlighter() has self-healed.
 * So renderMarkdown() below resets `rendererPromise` too, on ITS rejection.
 *
 * No double-init race: the reset (`rendererPromise = null`) and the
 * reassignment on the next call both happen synchronously within a single
 * `??=` expression, with no `await` in between — JS never interleaves two
 * synchronous sections, so two concurrent callers can never both observe
 * `null` and each kick off their own independent build. Every caller that
 * read the promise before a reset keeps awaiting that SAME promise object
 * (and gets the SAME outcome); only the next call after a reset builds anew.
 */
let rendererPromise: Promise<ReturnType<typeof buildRenderer>> | null = null;
async function buildRendererAsync(): Promise<ReturnType<typeof buildRenderer>> {
  return buildRenderer(await getHighlighter());
}

/** Render `markdown` to HTML that is safe to embed. */
export async function renderMarkdown(markdown: string): Promise<string> {
  rendererPromise ??= buildRendererAsync().catch((error: unknown) => {
    rendererPromise = null;
    throw error;
  });
  const renderer = await rendererPromise;
  return String(await renderer.process(markdown));
}
