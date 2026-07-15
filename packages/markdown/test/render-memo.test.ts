import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ⚠️ THE SAME BUG, ONE LAYER UP. `renderMarkdown()` memoizes `rendererPromise
 * ??= buildRendererAsync()` (src/render.ts) — a promise object stored
 * synchronously, before it settles, exactly like `highlighterPromise` in
 * src/highlight.ts (pinned in test/highlight-memo.test.ts). Even though
 * getHighlighter() resets ITS OWN memo on rejection, that alone is not
 * enough: `rendererPromise` would still hold the outer, now-rejected
 * buildRendererAsync() promise, so renderMarkdown() would keep re-awaiting
 * that same rejection forever even after getHighlighter() has self-healed.
 * This mocks "./highlight" to fail once, then succeed, and asserts
 * renderMarkdown() recovers on the very next call.
 */
describe("renderMarkdown() renderer memoization (must not cache a rejection)", () => {
  afterEach(() => {
    vi.doUnmock("../src/highlight");
    vi.resetModules();
  });

  it("resets rendererPromise on rejection so the next render retries", async () => {
    let calls = 0;
    // Resolved relative to THIS file; src/render.ts's own "./highlight"
    // specifier resolves to the same module, so mocking it here intercepts it.
    vi.doMock("../src/highlight", () => ({
      HIGHLIGHT_THEME: "github-dark",
      getHighlighter: vi.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("transient highlighter init failure"));
        return Promise.resolve({ getLoadedLanguages: () => [] });
      }),
    }));

    const { renderMarkdown } = await import("../src/render");

    await expect(renderMarkdown("hello")).rejects.toThrow("transient highlighter init failure");
    // A naive `rendererPromise ??= buildRendererAsync()` would still hold the
    // FIRST (rejected) promise here and this would reject again with the
    // SAME error, even though getHighlighter() would succeed if retried.
    await expect(renderMarkdown("hello")).resolves.toContain("hello");
    expect(calls, "buildRendererAsync must be retried, not skipped, after a reset").toBe(2);
  });
});
