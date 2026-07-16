import { describe, expect, it } from "vitest";

import { timingSafeEqual } from "../src/timing-safe";

/**
 * ⚠️ THESE TESTS EXIST BECAUSE THE FUNCTION'S OWN DOC-COMMENT PREDICTS THEIR
 * ABSENCE WOULD BE FATAL: a "cleanup" that early-returns on the first differing
 * character "would silently turn either into a timing oracle while every test
 * stayed green." Until now the only coverage was indirect (apps/api's csrf suite,
 * via `checkCsrf`) — and `web` compares the purge shared secret with the same
 * function, from a different package. One definition, so: tests next to it.
 *
 * ⚠️ WHAT THESE CANNOT PROVE. Constant-TIME is not observable from a unit test:
 * timing a JIT-compiled comparison in a test runner measures the runtime, not the
 * algorithm. So these pin the CONTRACT (the correctness half) and the two cases
 * whose answers are load-bearing elsewhere and easy to "simplify" wrongly. The
 * no-early-return property is guarded by the doc-comment and by review — assert
 * what is real rather than a timing test that would flake.
 */
describe("timingSafeEqual", () => {
  it("is true for equal strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });

  it("is false for same-length strings differing in ONE character", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
  });

  it("is false when only the FIRST character differs", () => {
    // The case an early-return "optimization" would answer fastest — and the one
    // that would make it a timing oracle. Same answer as every other mismatch.
    expect(timingSafeEqual("Xbc123", "abc123")).toBe(false);
  });

  it("is false when only the LAST character differs", () => {
    expect(timingSafeEqual("abc12X", "abc123")).toBe(false);
  });

  it("is false for a PREFIX (length mismatch)", () => {
    // ⚠️ LOAD-BEARING for the purge hop: a truncated secret must not authorize.
    // apps/web/src/lib/purge.ts relies on this being the length check, not a
    // character match on the part that lines up.
    expect(timingSafeEqual("abc", "abc123")).toBe(false);
    expect(timingSafeEqual("abc123", "abc")).toBe(false);
  });

  it("⚠️ is TRUE for two empty strings — which is why callers must guard", () => {
    // NOT a bug, and NOT something to "fix" here: two empty strings ARE equal.
    // It is pinned because it is a live footgun one layer up — an unset/empty
    // secret compared against an empty submitted value would authorize the
    // caller. apps/web/src/lib/purge.ts's `authorized()` guards `=== ""`
    // explicitly BECAUSE of this, and web is the public Worker. If this ever
    // returns false, that guard looks redundant and someone will delete it.
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("is false for an empty string against a non-empty one", () => {
    expect(timingSafeEqual("", "abc")).toBe(false);
  });

  it("handles non-ASCII without throwing (charCodeAt is UTF-16 code units)", () => {
    expect(timingSafeEqual("café", "café")).toBe(true);
    expect(timingSafeEqual("café", "cafe")).toBe(false);
  });
});
