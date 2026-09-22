/**
 * THE TURNSTILE DEPLOY-BUILD GUARD (#89 follow-up).
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
 * ⚠️⚠️ FIRST DRAFT OF THIS FILE WAS WRONG, AND THE BUG IS WORTH RECORDING.
 * It keyed EVERYTHING — including the "is this actually the deploy build"
 * question — off `PUBLIC_TURNSTILE_SITE_KEY` itself: "if the key is set,
 * `dist/` must not contain dummy-token." That statement is TRUE and the
 * measurements behind it were real (esbuild does DCE the fallback branch
 * when the key is a build-time-inlined constant) — but it is vacuously
 * satisfied whenever the key is ABSENT, which is EXACTLY #89's failure
 * mode: the key was never set on the deploy build at all. Traced end to
 * end (PM review, verified): that version of this guard would have PASSED
 * the exact build that broke production. A check gated on configuration
 * that might itself be missing inherits the same failure mode as the thing
 * it guards — the same lesson #89 taught one level up, and neither this
 * file's own first-draft tests nor a straightforward review would have
 * shown it, because a vacuously-true guard looks identical to a passing one.
 *
 * ⚠️ THE FIX: a signal that says "this IS the deploy build" INDEPENDENTLY of
 * whether its configuration is correct — not introduced here, but OBSERVED.
 * Cloudflare Workers Builds injects `WORKERS_CI=1` on every build it runs
 * (https://developers.cloudflare.com/workers/ci-cd/builds/configuration/,
 * "Changing build behaviour when run on Workers Builds versus locally" is
 * its documented purpose) — distinct from the bare `CI` var, which GitHub
 * Actions ALSO sets, so `CI` alone cannot tell a Workers Builds deploy apart
 * from this repo's own GitHub Actions CI. `WORKERS_CI` is Cloudflare's own,
 * automatically stamped, not something anyone here configures or could
 * forget to set — which is the property `PUBLIC_TURNSTILE_SITE_KEY` does
 * NOT have (CireSnave forgetting to set exactly that is #89). So the
 * PRIMARY assertion is now: on a Workers Builds run, the site key MUST be
 * present, full stop — a production build without it is a failed build, by
 * CireSnave's own ruling. The dummy-token scan is now the SECONDARY,
 * belt-and-braces check for a DIFFERENT residual risk (the DCE not firing,
 * or someone hardcoding the literal string later) — it can only ever fire
 * once the primary check has already confirmed the key is present.
 *
 * ⚠️ VERIFIED EMPIRICALLY THAT THE DCE CLAIM IS TRUE, not assumed: a
 * production-shaped build (`PUBLIC_TURNSTILE_SITE_KEY` set) esbuild-minifies
 * `turnstileSiteKey ? <real widget> : <dummy fallback>` down to ONLY the
 * true branch once the condition is a build-time-inlined non-empty string
 * constant — `dummy-token` does not appear anywhere under `dist/` in that
 * build. Built WITHOUT the key (the normal dev/CI path), it appears in
 * exactly the two expected compiled chunks (signup, forgot-password). Both
 * observed directly, which is also the SECONDARY check's own positive/
 * negative control — see test/turnstile-build-guard.node.test.ts.
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
 * THE PRIMARY CHECK. Throws if `env.WORKERS_CI === "1"` (this really is a
 * Cloudflare Workers Builds run) AND `env.PUBLIC_TURNSTILE_SITE_KEY` is
 * unset/empty. A no-op everywhere else — local dev, this repo's own GitHub
 * Actions CI (which sets `CI` but not `WORKERS_CI`), and a genuinely
 * misconfigured local `WORKERS_CI=1` experiment all fall through silently
 * by design; a false positive here would train someone to bypass it, which
 * is worse than not having it.
 *
 * @param {Record<string, string | undefined>} [env] See
 *   `assertNoDummyTokenLeak`'s identical parameter doc for why this is a
 *   plain string-map type, not `NodeJS.ProcessEnv`.
 */
export function assertTurnstileKeySetOnDeploy(env = process.env) {
  if (env.WORKERS_CI !== "1") return;
  const siteKey = env.PUBLIC_TURNSTILE_SITE_KEY;
  if (siteKey !== undefined && siteKey !== "") return;

  throw new Error(
    "[turnstile-build-guard] WORKERS_CI=1 (this IS a Cloudflare Workers " +
      "Builds run) but PUBLIC_TURNSTILE_SITE_KEY is unset. This is #89: " +
      "without it, signup.astro/forgot-password.astro silently ship their " +
      "dev/e2e dummy-token Turnstile fallback — bot defense on signup and " +
      "password reset goes dark in production with no visible symptom " +
      "until someone actually abuses the form. CireSnave's ruling: a " +
      "production build without the key is a failed build. Set " +
      "PUBLIC_TURNSTILE_SITE_KEY on this Workers Builds project's " +
      "environment variables (Cloudflare dashboard) and rebuild — this is " +
      "not something the build script can fix for you.",
  );
}

/**
 * THE SECONDARY CHECK. Throws if `distDir` leaks `dummy-token` AND
 * `env.PUBLIC_TURNSTILE_SITE_KEY` is a non-empty string — i.e. the build
 * declared itself production-shaped by the ONE mechanism the app's own
 * pages already read (`turnstileSiteKey ? real : dummy` in each `.astro`
 * file). A no-op when the key is unset: that is the legitimate dev/CI/e2e
 * path, and nothing here may reject it. ⚠️ Deliberately independent of
 * `WORKERS_CI` — this is a fallback for "the key was set correctly but the
 * fallback still leaked anyway" (DCE not firing, a future hardcoded copy of
 * the string), not a restatement of the primary check above.
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
