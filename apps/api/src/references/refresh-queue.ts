// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2c-3a: choosing which references to refresh now. RED-FIRST STUB: the body lands in the next commit.
 * The queue itself is created at deploy time (board 418); code refers to it by this name only.
 */
import type { Client } from "pg";

export const REFRESH_QUEUE = "reference-refresh";
/** How long a claimed reference is left alone, so a lost message or a crashed consumer is retried, not forgotten. */
export const LEASE_MS = 10 * 60_000;
/** How many references one sweep claims. */
export const SWEEP_BATCH = 100;

/** The Queue message body: the id only, so a retry reads the row's current state. */
export interface RefreshMessage {
  referenceId: string;
}

export function claimDueRefreshes(_db: Client, _now: Date, _limit: number = SWEEP_BATCH): Promise<string[]> {
  return Promise.reject(new Error("claimDueRefreshes: not implemented"));
}
