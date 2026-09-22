/**
 * THE TURNSTILE DUMMY-TOKEN BUILD GUARD (#89 follow-up).
 *
 * CireSnave's ruling, verbatim: "A production build containing dummy-token
 * should fail."
 *
 * ⚠️ THIS IS THE GUARD ONLY — NOT THE #89 FIX. Setting
 * `PUBLIC_TURNSTILE_SITE_KEY` on the deploy build is CireSnave's own
 * Cloudflare dashboard action; this script does not attempt it and cannot
 * substitute for it. What THIS closes is the NEXT failure of the same
 * shape: `signup.astro` and `forgot-password.astro` fall back to a visible,
 * always-pass `<input value="dummy-token">` field whenever
 * `PUBLIC_TURNSTILE_SITE_KEY` is unset at build time — correct and required
 * for local dev and CI (a domain-locked real widget cannot render in a
 * headless browser), but if the deploy build EVER ships that fallback, bot
 * defense on signup and password reset is silently gone in production,
 * indistinguishable from a working form until someone actually submits it —
 * exactly what happened in #89.
 *
 * ⚠️ THE HARD PART IS NOT DETECTING THE STRING — it is distinguishing a
 * deploy build from a legitimate dev/CI one WITHOUT a signal that can be
 * silently disarmed. There is no first-party "this is the real deploy" flag
 * anywhere in this repo (README.md's Workers Builds runbook: the build
 * command is the same `pnpm --filter @thinkersjournal/web build` everywhere
 * — the only thing that differs on the real deploy is that
 * `PUBLIC_TURNSTILE_SITE_KEY` is set, in Cloudflare's dashboard, outside
 * version control). So this guard is keyed on THAT SAME variable, and
 * ONLY that variable — not a separate opt-out flag a CI config could set
 * and forget: the same env var that turns the REAL Turnstile widget on is
 * what turns this check on, so disarming the guard means disarming the
 * feature it protects, not a quiet parallel toggle nobody notices.
 *
 * ⚠️ VERIFIED EMPIRICALLY THAT THIS IS DETECTABLE AT ALL, not assumed: a
 * production-shaped build (`PUBLIC_TURNSTILE_SITE_KEY` set) esbuild-minifies
 * `turnstileSiteKey ? <real widget> : <dummy fallback>` down to ONLY the
 * true branch once the condition is a build-time-inlined non-empty string
 * constant — `dummy-token` does not appear anywhere under `dist/` in that
 * build. Built WITHOUT the key (the normal dev/CI path), it appears in
 * exactly the two expected compiled chunks (signup, forgot-password). Both
 * observed directly (not read from a doc), which is also the guard's own
 * positive/negative control — see test/turnstile-build-guard.node.test.ts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every occurrence of `dummy-token` under `distDir`, as paths relative to it.
 * Empty array means clean. Scans EVERY file in the build output — a curated
 * extension allowlist is exactly the shape of guard that misses the one
 * asset type nobody thought to add (the hidden-at-read-guard/DMCA-phone
 * guards in this codebase make the identical choice, for the identical
 * reason). A file that cannot be read as UTF-8 (a font, an image) simply
 * cannot contain this ASCII literal meaningfully and is skipped.
 */
export function findDummyTokenLeak(distDir) {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      let text;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (text.includes("dummy-token")) {
        offenders.push(relative(distDir, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(distDir);
  return offenders;
}

/**
 * Throws if `distDir` leaks `dummy-token` AND `env.PUBLIC_TURNSTILE_SITE_KEY`
 * is a non-empty string — i.e. this build declared itself production-shaped.
 * A no-op (never scans-to-fail) when the key is unset: that is the
 * legitimate dev/CI/e2e path, and nothing here may reject it.
 *
 * @param {string} distDir
 * @param {Record<string, string | undefined>} [env] Deliberately a PLAIN
 *   string-map type, not `NodeJS.ProcessEnv` — this repo's own
 *   `worker-configuration.d.ts` augments that global with Worker-specific
 *   REQUIRED keys (`PURGE_SECRET` etc.) that have nothing to do with this
 *   check and would make a bare `process.env` default untypeable from a
 *   caller passing a minimal test fixture.
 */
export function assertNoDummyTokenLeak(distDir, env = process.env) {
  const siteKey = env.PUBLIC_TURNSTILE_SITE_KEY;
  if (siteKey === undefined || siteKey === "") return;

  const offenders = findDummyTokenLeak(distDir);
  if (offenders.length === 0) return;

  throw new Error(
    "[turnstile-build-guard] PUBLIC_TURNSTILE_SITE_KEY is set (this build " +
      "declares itself production-shaped), but the built output still " +
      "contains the dev/e2e-only \"dummy-token\" Turnstile fallback:\n" +
      offenders.map((o) => `  - ${o}`).join("\n") +
      "\nThis is the exact shape of #89 (signup + password reset shipped " +
      "with bot defense silently disabled). CireSnave's ruling: a " +
      "production build containing dummy-token must fail, not ship. Do " +
      "not disposition this away — find why the dummy branch survived " +
      "with a real site key present.",
  );
}
