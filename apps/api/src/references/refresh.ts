// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2c-2: refresh ONE stored reference (spec docs/superpowers/specs/2026-11-09-m3-connector-contract.md section 3,
 * design decision 22). RED-FIRST STUB: the body lands in the next commit.
 */
import type { Registry } from "./registry";
import type { SpendResult } from "./author-budget";
import type { FetchCtx } from "@thinkersjournal/shared";
import type { Client } from "pg";

/** The per-author budget. In production this is `env.AUTHOR_BUDGET.getByName(authorId).take(cost)`. */
export interface RefreshBudget {
  take(authorId: string, cost: number): Promise<SpendResult>;
}

export interface RefreshDeps {
  registry: Registry;
  ctx: FetchCtx;
  budget: RefreshBudget;
  now: Date;
}

export type RefreshOutcome = "missing" | "gone" | "orphan" | "throttled" | "unknown" | "refreshed";

export function refreshReference(_db: Client, _referenceId: string, _deps: RefreshDeps): Promise<RefreshOutcome> {
  return Promise.reject(new Error("refreshReference: not implemented"));
}
