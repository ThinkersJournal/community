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
import rehypeExternalLinks from "rehype-external-links";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

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
 */
const schema: typeof defaultSchema = {
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

function buildRenderer() {
  return (
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      // allowDangerousHtml is false by DEFAULT => raw HTML is dropped here.
      .use(remarkRehype)
      // ─────────────────────────────────────────────────────────────────────
      // ⚠️ THE LAST UNSAFE THING IS ABOVE THIS LINE.
      .use(rehypeSanitize, schema)
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
      // Task 6 inserts Shiki here. M3 inserts the ref-card plugin here.
      .use(rehypeStringify)
  );
}

/**
 * Memoized because Task 6 makes construction genuinely async (Shiki's
 * highlighter init). Declared async NOW so that task adds a step rather than
 * changing this module's signature and every call site with it.
 */
let rendererPromise: ReturnType<typeof buildRendererAsync> | null = null;
async function buildRendererAsync(): Promise<ReturnType<typeof buildRenderer>> {
  return buildRenderer();
}

/** Render `markdown` to HTML that is safe to embed. */
export async function renderMarkdown(markdown: string): Promise<string> {
  rendererPromise ??= buildRendererAsync();
  const renderer = await rendererPromise;
  return String(await renderer.process(markdown));
}
