// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2d: garbage-collect unreferenced references (spec docs/superpowers/specs/2026-11-09-m3-connector-contract.md section 4:
 * "A reference nobody uses (no `post_references`) is garbage-collected by the existing sweep pattern").
 *
 * An orphan is a `"references"` row with no `post_references` row. It arises when the last post that used it is deleted
 * (the use cascades away) or an author removes the card. `refreshReference` already parks it dormant
 * (`next_check_at` NULL); this sweep removes it.
 *
 * ⚠️ GRACE WINDOW, keyed on the later of `created_at` and `updated_at`. `upsertReference` (attach.ts) bumps `updated_at`
 * when a re-resolve lands on an existing row, so a row an author is attaching right now is never old enough, and a
 * compose in progress cannot lose its reference. The residual race is an attach that upserts, then this DELETE, then the
 * `post_references` INSERT; it needs the row to be older than the window AND untouched, which the upsert's own bump rules out.
 *
 * `FOR UPDATE SKIP LOCKED` so two sweeps never fight over a row. The FK from `post_references` has no cascade, so a use
 * inserted after the NOT EXISTS check makes the DELETE fail rather than lose data.
 */
import type { Client } from "pg";

/** An unused row younger than this survives (24 h, like the orphan-media reaper). */
export const GC_GRACE_MS = 24 * 60 * 60 * 1000;
/** One run's cap, so a backlog is finished over later runs and never one unbounded statement. */
export const GC_BATCH = 500;

/** Delete up to `limit` orphan references older than the grace window at `now`. Returns how many were deleted. */
export async function gcOrphanReferences(db: Client, now: Date, limit: number = GC_BATCH): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM "references"
      WHERE id IN (
        SELECT r.id FROM "references" r
         WHERE GREATEST(r.created_at, r.updated_at) < $1
           AND NOT EXISTS (SELECT 1 FROM post_references pr WHERE pr.reference_id = r.id)
         ORDER BY r.created_at, r.id
         LIMIT $2
         FOR UPDATE OF r SKIP LOCKED)`,
    [new Date(now.getTime() - GC_GRACE_MS), limit],
  );
  return rowCount ?? 0;
}
