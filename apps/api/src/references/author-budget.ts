// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2b: pure token bucket for the per-author refresh budget (design decision 22). No I/O: `AuthorBudgetDO` (next slice)
 * persists the state and calls `spend`. A refused spend never changes the balance; it says when to retry.
 */

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

/** Spend `cost` tokens at `now` (epoch ms). A null state is a new author: a full bucket. */
export function spend(state: BucketState | null, now: number, cost: number, cfg: BucketConfig): SpendResult {
  const prev: BucketState = state ?? { tokens: cfg.capacity, at: now };
  // A clock that went backwards neither refills nor spends extra: elapsed is floored at 0 and `at` never regresses.
  const elapsed = Math.max(0, now - prev.at);
  const at = Math.max(now, prev.at);
  const tokens = Math.min(cfg.capacity, prev.tokens + elapsed * cfg.refillPerMs);
  if (cost > cfg.capacity) return { ok: false, state: { tokens, at }, retryAfterMs: Number.POSITIVE_INFINITY };
  if (tokens >= cost) return { ok: true, state: { tokens: tokens - cost, at } };
  return { ok: false, state: { tokens, at }, retryAfterMs: Math.ceil((cost - tokens) / cfg.refillPerMs) };
}
