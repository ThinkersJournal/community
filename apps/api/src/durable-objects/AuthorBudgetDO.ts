// SPDX-License-Identifier: MIT OR Apache-2.0
/** `AuthorBudgetDO` (M3.2b): one instance per author id; persists the token bucket of `references/author-budget.ts`. STUB: red-first. */
import { DurableObject } from "cloudflare:workers";

import type { SpendResult } from "../references/author-budget";

export class AuthorBudgetDO extends DurableObject<Env> {
  /** Spend `cost` tokens at the explicit clock `now` (epoch ms). Tests call this; `take` uses the real clock. */
  takeAt(_cost: number, _now: number): Promise<SpendResult> {
    return Promise.reject(new Error("not implemented"));
  }

  take(cost: number): Promise<SpendResult> {
    return this.takeAt(cost, Date.now());
  }
}
