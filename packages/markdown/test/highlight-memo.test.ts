import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ⚠️ PINS THE M0 ARGON2 BUG, RECURRED. `highlighterPromise ??= x` (src/highlight.ts)
 * and `rendererPromise ??= x` (src/render.ts) both store a PROMISE OBJECT
 * synchronously, before it settles. A naive memo therefore caches a REJECTED
 * promise for the isolate's lifetime: one transient init failure and every
 * subsequent renderMarkdown() call 500s forever, even though a fresh attempt
 * would have succeeded. This is exactly the bug M0 hit with argon2's memoized
 * WASM init (fixed there by resetting the memo on rejection).
 *
 * These tests mock `shiki/core` to fail on its first call and succeed on its
 * second, driving getHighlighter() through a real rejection, and assert the
 * NEXT call retries (rather than replaying the same rejection) — and that
 * concurrent callers during a failing init share exactly ONE underlying init
 * attempt (no double-init race introduced by the reset).
 */
describe("getHighlighter() init memoization (must not cache a rejection)", () => {
  afterEach(() => {
    vi.doUnmock("shiki/core");
    vi.resetModules();
  });

  it("resets the memo on rejection so the next call retries instead of replaying the failure forever", async () => {
    let calls = 0;
    vi.doMock("shiki/core", () => ({
      createHighlighterCore: vi.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("transient init failure"));
        return Promise.resolve({ getLoadedLanguages: () => [] });
      }),
    }));

    const { getHighlighter } = await import("../src/highlight");

    await expect(getHighlighter()).rejects.toThrow("transient init failure");
    // A naive `highlighterPromise ??= createHighlighterCore(...)` would still
    // hold the FIRST (rejected) promise here, and this second call would
    // reject with the SAME error without createHighlighterCore ever being
    // called again — that is the bug this test exists to catch.
    await expect(getHighlighter()).resolves.toBeDefined();
    expect(calls, "createHighlighterCore must be retried, not skipped, after a reset").toBe(2);
  });

  it("concurrent callers during a failing init share ONE init attempt, not two", async () => {
    let calls = 0;
    vi.doMock("shiki/core", () => ({
      createHighlighterCore: vi.fn(() => {
        calls += 1;
        return Promise.reject(new Error("boom"));
      }),
    }));

    const { getHighlighter } = await import("../src/highlight");

    const [a, b] = await Promise.allSettled([getHighlighter(), getHighlighter()]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    // Both calls happen before either settles, so both must observe the SAME
    // in-flight promise rather than each independently calling
    // createHighlighterCore — the "no double-init race" half of the guarantee.
    expect(calls, "concurrent callers must share one in-flight init, not start two").toBe(1);
  });
});
