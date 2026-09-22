import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertNoDummyTokenLeak,
  assertTurnstileKeySetOnDeploy,
  findDummyTokenLeak,
} from "../scripts/turnstile-build-guard.mjs";

/**
 * #89 follow-up — CireSnave's ruling, verbatim: "A production build
 * containing dummy-token should fail."
 *
 * ⚠️ `.node.test.ts`, no DB: this reads a real filesystem fixture directory,
 * same reasoning as test/hidden-at-read-guard.node.test.ts.
 *
 * ⚠️ THE FIRST VERSION OF THIS GUARD WAS WRONG, AND THIS FILE'S FIRST
 * VERSION DID NOT CATCH IT — see scripts/turnstile-build-guard.mjs's header
 * for the full trace (PM review). It checked only
 * `assertNoDummyTokenLeak`, gated on `PUBLIC_TURNSTILE_SITE_KEY` being
 * SET — vacuously satisfied whenever the key is ABSENT, which is exactly
 * #89's failure mode. The "does not throw when the key is UNSET" test below
 * still holds (that property is correct and load-bearing for
 * `assertNoDummyTokenLeak` specifically — it must never fire on the
 * legitimate dev/CI path), but on its own it left the actual #89 scenario
 * completely unrepresented in this file. The
 * "⚠️ THE #89 SCENARIO ITSELF" block below is what closes that gap.
 *
 * ⚠️ WHAT THIS FILE DOES AND DOES NOT PROVE. These are fast, hermetic
 * fixture-directory / env-object tests of the PURE checking logic — the
 * mutation-style "can this guard actually fail" proof (inject the exact
 * forced condition, assert it throws), same discipline as #80's author-hide
 * fix. They do NOT re-run a real `astro build` or spawn a real Workers
 * Builds environment, which this repo's own build-web.mjs already wraps
 * carefully for reasons unrelated to this guard.
 *
 * The REAL end-to-end proof that the underlying DCE claim is true — that a
 * genuine `PUBLIC_TURNSTILE_SITE_KEY`-set build's `dist/` contains ZERO
 * occurrences of "dummy-token", and that a normal key-unset build contains
 * it in EXACTLY `dist/server/chunks/forgot-password_*.mjs` and
 * `dist/server/chunks/signup_*.mjs` and nowhere else — was run manually
 * against this exact commit and is recorded in the PR description, not
 * re-asserted here as an automated test.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turnstile-guard-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findDummyTokenLeak", () => {
  it("finds a real leak — the non-vacuity control for everything below", () => {
    writeFileSync(join(dir, "chunk.mjs"), 'value="dummy-token"');
    expect(findDummyTokenLeak(dir)).toEqual(["chunk.mjs"]);
  });

  it("finds nothing in a clean tree", () => {
    writeFileSync(join(dir, "chunk.mjs"), 'const x = "real-token-abc123";');
    expect(findDummyTokenLeak(dir)).toEqual([]);
  });

  it("walks nested directories, same as a real dist/ tree", () => {
    writeFileSync(join(dir, "chunk.mjs"), "clean");
    const nested = join(dir, "server", "chunks");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "signup_ABC123.mjs"), 'value="dummy-token"');
    expect(findDummyTokenLeak(dir)).toEqual(["server/chunks/signup_ABC123.mjs"]);
  });
});

describe("⚠️ THE #89 SCENARIO ITSELF — assertTurnstileKeySetOnDeploy is the PRIMARY check", () => {
  it("⚠️ throws on a real Workers Builds run with no site key — the EXACT shape of #89", () => {
    // This is the regression this file's first version could not represent:
    // a genuine deploy build (WORKERS_CI=1) where the key was simply never
    // set. The old guard (checking only dummy-token-when-key-present) would
    // have been silent here, because ITS condition never fires either.
    expect(() =>
      assertTurnstileKeySetOnDeploy({ WORKERS_CI: "1" }),
    ).toThrow(/WORKERS_CI=1.*PUBLIC_TURNSTILE_SITE_KEY is unset/s);
  });

  it("does not throw on a real Workers Builds run WITH the key set — the actual fixed deploy", () => {
    expect(() =>
      assertTurnstileKeySetOnDeploy({ WORKERS_CI: "1", PUBLIC_TURNSTILE_SITE_KEY: "real-key" }),
    ).not.toThrow();
  });

  it("⚠️ does NOT throw with no key when WORKERS_CI is absent — local dev must stay silent", () => {
    expect(() => assertTurnstileKeySetOnDeploy({})).not.toThrow();
  });

  it("⚠️ does NOT throw with no key under this repo's OWN GitHub Actions CI — CI=true is not WORKERS_CI=1", () => {
    // The whole reason WORKERS_CI, not the bare CI var, is the signal: GitHub
    // Actions also sets CI=true, and this repo's e2e/build suites run there
    // with no Turnstile key by design (a domain-locked widget cannot render
    // headless). A guard keyed on CI alone would fail every PR.
    expect(() => assertTurnstileKeySetOnDeploy({ CI: "true" })).not.toThrow();
  });

  it("treats any WORKERS_CI value other than the literal \"1\" as NOT a Workers Builds run — fail closed on the SAFE side", () => {
    // Consistent with this codebase's other env-gate convention
    // (TEST_ROUTES, checkOrigin's dev-origin allowlist): an exact-string
    // check, not truthiness, so an unexpected value never silently WIDENS
    // what counts as "deploy". Here that means erring toward NOT firing
    // rather than firing on a value nobody chose — the guard's job is to
    // stop a bad deploy, not to become a new source of false failures on
    // whatever Cloudflare might set the var to next.
    expect(() => assertTurnstileKeySetOnDeploy({ WORKERS_CI: "true" })).not.toThrow();
  });
});

describe("assertNoDummyTokenLeak — the SECONDARY, belt-and-braces check", () => {
  it("throws when PUBLIC_TURNSTILE_SITE_KEY is set AND the fallback leaked anyway (DCE-not-firing case)", () => {
    writeFileSync(join(dir, "chunk.mjs"), 'value="dummy-token"');
    expect(() =>
      assertNoDummyTokenLeak(dir, { PUBLIC_TURNSTILE_SITE_KEY: "real-site-key-abc" }),
    ).toThrow(/dummy-token/);
  });

  it("the thrown message names the offending file — not just \"something leaked\"", () => {
    writeFileSync(join(dir, "chunk.mjs"), 'value="dummy-token"');
    try {
      assertNoDummyTokenLeak(dir, { PUBLIC_TURNSTILE_SITE_KEY: "real-site-key-abc" });
      expect.unreachable("expected assertNoDummyTokenLeak to throw");
    } catch (err) {
      expect((err as Error).message).toContain("chunk.mjs");
    }
  });

  it("⚠️ does NOT throw when the key is UNSET, even with the fallback present — the dev/CI path must stay open", () => {
    // Correct and load-bearing on its own terms (the legitimate dev/CI path
    // must never be rejected) — but see this file's header: this property
    // alone is NOT what makes the guard catch #89. That is
    // assertTurnstileKeySetOnDeploy's job, tested above.
    writeFileSync(join(dir, "chunk.mjs"), 'value="dummy-token"');
    expect(() => assertNoDummyTokenLeak(dir, {})).not.toThrow();
    expect(() => assertNoDummyTokenLeak(dir, { PUBLIC_TURNSTILE_SITE_KEY: "" })).not.toThrow();
  });

  it("does not throw when the key is set and the tree is clean — the normal production path passes", () => {
    writeFileSync(join(dir, "chunk.mjs"), "clean");
    expect(() =>
      assertNoDummyTokenLeak(dir, { PUBLIC_TURNSTILE_SITE_KEY: "real-site-key-abc" }),
    ).not.toThrow();
  });
});
