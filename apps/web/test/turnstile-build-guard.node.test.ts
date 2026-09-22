import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertNoDummyTokenLeak, findDummyTokenLeak } from "../scripts/turnstile-build-guard.mjs";

/**
 * #89 follow-up — CireSnave's ruling, verbatim: "A production build
 * containing dummy-token should fail."
 *
 * ⚠️ `.node.test.ts`, no DB: this reads a real filesystem fixture directory,
 * same reasoning as test/hidden-at-read-guard.node.test.ts.
 *
 * ⚠️ WHAT THIS FILE DOES AND DOES NOT PROVE. These are fast, hermetic
 * fixture-directory tests of the PURE checking logic — the mutation-style
 * "can this guard actually fail" proof (inject a forced leak, assert it
 * throws), same discipline as #80's author-hide fix. They do NOT re-run a
 * real `astro build`, which this repo's own build-web.mjs already wraps
 * carefully (workerd process reaping, Windows EPERM retries) for good
 * reasons unrelated to this guard — duplicating that inside the vitest pool
 * would be slow and fragile for no extra coverage of the logic itself.
 *
 * The REAL end-to-end proof — that a genuine `PUBLIC_TURNSTILE_SITE_KEY`-set
 * build's `dist/` contains ZERO occurrences of "dummy-token" (esbuild
 * dead-code-eliminates the whole fallback branch once the ternary's
 * condition is a build-time-inlined non-empty string constant), and that a
 * normal key-unset build contains it in EXACTLY
 * `dist/server/chunks/forgot-password_*.mjs` and
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

describe("⚠️ assertNoDummyTokenLeak — the mutation-style proof it can actually fail", () => {
  it("throws when PUBLIC_TURNSTILE_SITE_KEY is set AND the fallback leaked (the forced-failure case)", () => {
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
    // This is the property that makes the guard un-disarmable by a stray CI
    // flag: there is no separate opt-out to forget. The ONLY way to silence
    // it is to unset the very variable that also disables the real widget.
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
