/**
 * THE workerd COMPATIBILITY GATE. Bundles src/index.ts exactly as workerd would
 * see it and asserts TWO independent properties. Exits non-zero if either fails.
 *
 * 1. NO `node:` IMPORTS — enforced by esbuild's `platform: "browser"`, which
 *    hard-errors on any node built-in. (This half has always worked.)
 *
 * 2. ⚠️ NO WebAssembly — enforced by the grep below, and NOT by esbuild.
 *
 * ⚠️ WHY #2 EXISTS AS AN EXPLICIT ASSERTION: `--platform=browser` does NOTHING
 * about WASM. Verified empirically: swapping our JS regex engine for
 * `createOnigurumaEngine(import("shiki/wasm"))` and running the ORIGINAL
 * bundle-only version of this check BUILT SUCCESSFULLY — exit 0, ~840 KB, with
 * seven `WebAssembly.*` references (Module, instantiate, instantiateStreaming)
 * sitting in the output. The check reported green while shipping the exact
 * thing it existed to prevent.
 *
 * That matters because workerd FORBIDS runtime WASM compilation outright
 * ("CompileError: Wasm code generation disallowed by embedder" — the same wall
 * hash-wasm hit in M0). Shiki's Oniguruma engine compiles a regex engine from a
 * grammar AT RUNTIME, so it would 500 on EVERY code-fenced post — in
 * production, not here. Without this assertion, constraint #1 of Task 6 is
 * enforced by nothing but memory and code review.
 *
 * ⚠️ The argon2id static-`.wasm` precedent does NOT transfer and is not an
 * excuse to relax this: that works because a statically-imported `.wasm` yields
 * an ALREADY-COMPILED Module and argon2 is small, pure-compute, and
 * fixed-size-input. If a future task ever genuinely needs a static `.wasm`
 * here, that is a deliberate, reviewed decision — it must edit this file, not
 * discover the ban by a production 500.
 */
import { readFile } from "node:fs/promises";

import { build } from "esbuild";

const ENTRY = "src/index.ts";
const OUTFILE = "node_modules/.cache/workerd-check.mjs";

/**
 * Each pattern is a property workerd requires that esbuild will not check.
 * Matched against the BUNDLED output, so a dependency smuggling WASM in is
 * caught just as surely as our own code doing it.
 */
const FORBIDDEN = [
  {
    name: "WebAssembly",
    // The API itself, in any form: `WebAssembly.compile`, `new WebAssembly.Module`, etc.
    pattern: /\bWebAssembly\b/g,
    why: "workerd forbids runtime WASM compilation ('Wasm code generation disallowed by embedder'). Use Shiki's createJavaScriptRegexEngine(), NEVER createOnigurumaEngine(). See src/highlight.ts.",
  },
  {
    name: ".wasm module reference",
    // A statically-imported/fetched .wasm asset path surviving into the bundle.
    pattern: /[\w./-]+\.wasm\b/g,
    why: "A .wasm asset reached the bundle. Static .wasm is a deliberate, reviewed decision (see the argon2id note in this file's header) — it is not something to add by accident.",
  },
];

// `platform: "browser"` is load-bearing: it hard-errors on any `node:` import.
// Failing here is a workerd incompatibility, not a build hiccup.
await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: OUTFILE,
});

const bundle = await readFile(OUTFILE, "utf8");

let failed = false;
for (const { name, pattern, why } of FORBIDDEN) {
  const hits = [...bundle.matchAll(pattern)];
  if (hits.length === 0) continue;

  failed = true;
  const samples = [...new Set(hits.map((h) => h[0]))].slice(0, 5);
  console.error(`\n  ✗ FORBIDDEN IN THE workerd BUNDLE: ${name} (${hits.length} reference(s))`);
  console.error(`    ${why}`);
  console.error(`    e.g. ${samples.join(", ")}`);
}

if (failed) {
  console.error(`\n  ${OUTFILE} would 500 in workerd. See scripts/check-workerd.mjs.\n`);
  process.exit(1);
}

console.log(`  ✓ workerd-safe: no node: imports, no WebAssembly, no .wasm in ${OUTFILE}`);
