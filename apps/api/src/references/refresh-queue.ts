// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2c-3a: choosing which references to refresh now (design decision 22). The cron sweep calls `claimDueRefreshes` and
 * sends one Queue message per id; the consumer (2c-3b) runs `refreshReference` for each. The queue itself is created at
 * deploy time (board 418); code refers to it by this name only.
 *
 * A claim LEASES the row: `next_check_at` moves forward by `LEASE_MS`, so the next tick does not enqueue it again while
 * its message is in flight, and a lost message or a crashed consumer is simply retried when the lease ends. A refresh
 * overwrites `next_check_at` with the real schedule, so a lease never outlives a successful look.
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

/**
 * Claim up to `limit` references that are due at `now`, oldest first. Dormant (`next_check_at` NULL) and gone rows are
 * never due. One statement, and `FOR UPDATE SKIP LOCKED`, so two sweeps running at once never claim the same row.
 */
export async function claimDueRefreshes(db: Client, now: Date, limit: number = SWEEP_BATCH): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE "references" SET next_check_at = $2
      WHERE id IN (
        SELECT id FROM "references"
         WHERE next_check_at <= $1 AND gone_at IS NULL
         ORDER BY next_check_at, id
         LIMIT $3
        )
      RETURNING id`,
    [now, new Date(now.getTime() + LEASE_MS), limit],
  );
  return rows.map((r) => r.id);
}
