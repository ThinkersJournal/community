// SPDX-License-Identifier: MIT OR Apache-2.0
/** M3.2a: pure refresh scheduling and live_state merge (spec 2026-11-09-m3-connector-contract.md section 3). STUB: red-first. */
import type { Diff, LiveResult } from "@thinkersjournal/shared";

export interface LiveState {
  access: LiveResult["access"];
  diff: Diff;
  observedAt: string;
  snapshot?: LiveResult["snapshot"];
}

/** When to check next after a successful look; null = dormant (wakes on its next view). */
export function nextCheckAt(_now: Date, _lastViewedAt: Date | null): Date | null {
  throw new Error("not implemented");
}

/** When to retry after `failures` consecutive unknown outcomes (never a hot loop). */
export function retryAt(_now: Date, _failures: number): Date {
  throw new Error("not implemented");
}

/** The live_state to store after a fetchLive, or the previous one untouched. */
export function mergeLive(_prev: LiveState | null, _res: LiveResult, _now: Date): LiveState | null {
  throw new Error("not implemented");
}
