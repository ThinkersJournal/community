// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2a: pure refresh scheduling and live_state merge (spec 2026-11-09-m3-connector-contract.md section 3,
 * design decision 22). No I/O: the Queue consumer (later slice) calls these.
 *
 * ⚠️ ACCESS IS NOT DIFF: `rate_limited`, `error` and `forbidden` give `diff: "unknown"` and leave the stored live_state
 * unchanged. Only a definitive `gone` is recorded as gone.
 */
import type { Diff, LiveResult } from "@thinkersjournal/shared";

export interface LiveState {
  access: LiveResult["access"];
  diff: Diff;
  observedAt: string;
  snapshot?: LiveResult["snapshot"];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** [max age since last view, delay to next check]. Past the last row the reference is dormant. */
const TAPER: ReadonlyArray<readonly [number, number]> = [
  [HOUR, 5 * MIN],
  [DAY, HOUR],
  [7 * DAY, 6 * HOUR],
  [21 * DAY, DAY],
];

/** When to check next after a successful look; null = dormant (wakes on its next view). */
export function nextCheckAt(now: Date, lastViewedAt: Date | null): Date | null {
  if (lastViewedAt === null) return null;
  const age = now.getTime() - lastViewedAt.getTime();
  for (const [maxAge, delay] of TAPER) {
    if (age <= maxAge) return new Date(now.getTime() + delay);
  }
  return null;
}

/** When to retry after `failures` consecutive unknown outcomes: 15 min doubling, capped at 24 h. Never a hot loop. */
export function retryAt(now: Date, failures: number): Date {
  const n = Math.max(0, Math.min(Math.floor(failures), 20));
  return new Date(now.getTime() + Math.min(15 * MIN * 2 ** n, DAY));
}

/** The live_state to store after a fetchLive, or the previous one untouched. */
export function mergeLive(prev: LiveState | null, res: LiveResult, now: Date): LiveState | null {
  const observedAt = now.toISOString();
  if (res.diff === "unknown") return prev;
  if (res.diff === "unchanged") return prev === null ? { access: res.access, diff: "unchanged", observedAt } : { ...prev, observedAt };
  const out: LiveState = { access: res.access, diff: res.diff, observedAt };
  if (res.snapshot !== undefined && res.diff !== "gone") out.snapshot = res.snapshot;
  return out;
}
