// SPDX-License-Identifier: MIT OR Apache-2.0
/** M3.2b: pure token bucket for the per-author refresh budget (design decision 22). STUB: red-first. */

export interface BucketState {
  /** Tokens left at `at`, fractional. */
  tokens: number;
  /** Epoch ms of the last update. */
  at: number;
}

export interface BucketConfig {
  capacity: number;
  /** Tokens added per millisecond. */
  refillPerMs: number;
}

/** One refresh costs 1 token; 60 tokens, refilled at 60 per hour. */
export const AUTHOR_BUDGET: BucketConfig = { capacity: 60, refillPerMs: 60 / 3_600_000 };

export type SpendResult = { ok: true; state: BucketState } | { ok: false; state: BucketState; retryAfterMs: number };

export function spend(_state: BucketState | null, _now: number, _cost: number, _cfg: BucketConfig): SpendResult {
  throw new Error("not implemented");
}
