// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.2b: per-author refresh budget as a pure token bucket. A refused spend says when to retry; it never spends.
import { describe, expect, it } from "vitest";

import { AUTHOR_BUDGET, spend, type BucketConfig, type BucketState } from "../src/references/author-budget";

const CFG: BucketConfig = { capacity: 10, refillPerMs: 1 / 1000 }; // 1 token per second
const T0 = 1_000_000;

describe("spend", () => {
  it("a new author starts with a full bucket", () => {
    const r = spend(null, T0, 1, CFG);
    expect(r.ok).toBe(true);
    expect(r.state).toEqual({ tokens: 9, at: T0 });
  });
  it("spends down to zero, then refuses without changing the balance", () => {
    let s: BucketState | null = null;
    for (let i = 0; i < 10; i++) {
      const r = spend(s, T0, 1, CFG);
      expect(r.ok).toBe(true);
      s = r.state;
    }
    const refused = spend(s, T0, 1, CFG);
    expect(refused.ok).toBe(false);
    expect(refused.state).toEqual({ tokens: 0, at: T0 });
    if (!refused.ok) expect(refused.retryAfterMs).toBe(1000);
  });
  it("refills with time, capped at capacity", () => {
    const empty: BucketState = { tokens: 0, at: T0 };
    expect(spend(empty, T0 + 3000, 1, CFG).state.tokens).toBeCloseTo(2, 6);
    expect(spend(empty, T0 + 3_600_000, 1, CFG).state.tokens).toBe(9);
  });
  it("retryAfterMs is the time until the cost is available", () => {
    const s: BucketState = { tokens: 0.5, at: T0 };
    const r = spend(s, T0, 1, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterMs).toBe(500);
  });
  it("a clock that goes backwards neither refills nor spends extra", () => {
    const s: BucketState = { tokens: 4, at: T0 };
    const r = spend(s, T0 - 5000, 1, CFG);
    expect(r.ok).toBe(true);
    expect(r.state.tokens).toBe(3);
  });
  it("a cost above capacity is always refused", () => {
    const r = spend(null, T0, 11, CFG);
    expect(r.ok).toBe(false);
  });
  it("the shipped config is 60 tokens refilled at 60 per hour", () => {
    expect(AUTHOR_BUDGET.capacity).toBe(60);
    expect(AUTHOR_BUDGET.refillPerMs * 3_600_000).toBeCloseTo(60, 9);
  });
});
