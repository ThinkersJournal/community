/**
 * ⚠️ createHighlighterCore + the JAVASCRIPT REGEX ENGINE — NO WASM AT ALL.
 *
 * The full `shiki` bundle is two failures at once: bundle size, and Oniguruma's
 * RUNTIME WebAssembly, which workerd forbids outright ("Wasm code generation
 * disallowed by embedder") — the same wall hash-wasm hit in M0.
 *
 * ⚠️ THE argon2id STATIC-.wasm PRECEDENT DOES NOT TRANSFER. That works because
 * a statically-imported `.wasm` yields an ALREADY-COMPILED Module and argon2 is
 * small, pure-compute, and fixed-size-input. A regex engine compiled at runtime
 * from a grammar is none of those. createJavaScriptRegexEngine() sidesteps the
 * question entirely.
 */
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import type { HighlighterCore } from "shiki/core";

export const HIGHLIGHT_THEME = "github-dark";

/**
 * THE EXPLICIT ALLOWLIST. Every entry costs bundle size, so this is a curated
 * launch set, not "everything Shiki has". Anything else renders as plain text
 * (src/lang-allowlist.ts) rather than throwing.
 */
export const HIGHLIGHT_LANGS = [
  "typescript", "javascript", "tsx", "jsx", "json", "html", "css",
  "bash", "python", "rust", "go", "sql", "yaml", "markdown", "diff",
] as const;

let highlighterPromise: Promise<HighlighterCore> | null = null;

/**
 * The process-wide highlighter. Built once per isolate; never per render.
 *
 * ⚠️ DOES NOT CACHE A REJECTED PROMISE. `??=` alone would memoize a transient
 * init failure for the isolate's lifetime — every subsequent render would
 * throw forever (this is exactly the bug M0 hit with argon2's memoized WASM
 * init). On rejection the memo is reset so the NEXT call retries from
 * scratch. The reset happens off the SAME promise object that was stored, so
 * a concurrent caller that already read `highlighterPromise` before the
 * reset still awaits that one settled (rejected) promise rather than a
 * half-built new one — no double-init race, and no caller ever observes a
 * promise that resolves to a different highlighter than the one it awaited.
 */
export async function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [import("@shikijs/themes/github-dark")],
    langs: [
      import("@shikijs/langs/typescript"),
      import("@shikijs/langs/javascript"),
      import("@shikijs/langs/tsx"),
      import("@shikijs/langs/jsx"),
      import("@shikijs/langs/json"),
      import("@shikijs/langs/html"),
      import("@shikijs/langs/css"),
      import("@shikijs/langs/bash"),
      import("@shikijs/langs/python"),
      import("@shikijs/langs/rust"),
      import("@shikijs/langs/go"),
      import("@shikijs/langs/sql"),
      import("@shikijs/langs/yaml"),
      import("@shikijs/langs/markdown"),
      import("@shikijs/langs/diff"),
    ],
    engine: createJavaScriptRegexEngine(),
  }).catch((error: unknown) => {
    // Reset the memo so the NEXT call retries instead of replaying this
    // rejection for the isolate's lifetime. Rethrow so THIS call still
    // rejects, too — a failed init must not look like a plain-text highlighter.
    highlighterPromise = null;
    throw error;
  });
  return await highlighterPromise;
}
