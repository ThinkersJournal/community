// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * `AuthorBudgetDO` (M3.2b): one instance per author id (`env.AUTHOR_BUDGET.getByName(authorId)`); persists the token
 * bucket of `references/author-budget.ts`. Not reachable from a route: the refresh runner is its only caller.
 *
 * A refused spend still writes the refilled balance (harmless and keeps the stored clock current); it never spends.
 */
import { DurableObject } from "cloudflare:workers";

import { AUTHOR_BUDGET, spend, type BucketState, type SpendResult } from "../references/author-budget";

type BucketRow = { tokens: number; at: number };

export class AuthorBudgetDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS bucket (id INTEGER PRIMARY KEY CHECK (id = 1), tokens REAL NOT NULL, at INTEGER NOT NULL)",
      );
      return Promise.resolve();
    });
  }

  /** Spend `cost` tokens at the explicit clock `now` (epoch ms). Tests call this; `take` uses the real clock. */
  takeAt(cost: number, now: number): Promise<SpendResult> {
    if (!Number.isInteger(cost) || cost <= 0) return Promise.reject(new RangeError("cost must be a positive integer"));
    const sql = this.ctx.storage.sql;
    const row = sql.exec<BucketRow>("SELECT tokens, at FROM bucket WHERE id = 1").toArray()[0];
    const prev: BucketState | null = row === undefined ? null : { tokens: row.tokens, at: row.at };
    const result = spend(prev, now, cost, AUTHOR_BUDGET);
    sql.exec(
      "INSERT INTO bucket (id, tokens, at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET tokens = excluded.tokens, at = excluded.at",
      result.state.tokens,
      result.state.at,
    );
    return Promise.resolve(result);
  }

  take(cost: number): Promise<SpendResult> {
    return this.takeAt(cost, Date.now());
  }
}
