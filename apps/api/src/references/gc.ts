// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2d: garbage-collect unreferenced references (spec docs/superpowers/specs/2026-11-09-m3-connector-contract.md section 4:
 * "A reference nobody uses (no `post_references`) is garbage-collected by the existing sweep pattern").
 *
 * An orphan is a `"references"` row with no `post_references` row. It arises when the last post that used it is deleted
 * (the use cascades away) or an author removes the card. `refreshReference` already parks it dormant
 * (`next_check_at` NULL); this sweep removes it.
 *
 * ⚠️ RETENTION FLOOR: ONE YEAR, keyed on the later of `created_at` and `updated_at` (PM ruling, 2026-11-16, reading
 * CireSnave's #58 Q2 "minimum of 1 year"). Nothing is deleted before it, and a row someone is attaching right now is
 * never old enough: `upsertReference` (attach.ts) bumps `updated_at` when a re-resolve lands on an existing row.
 *
 * Why a year and not a day: a hard-deleted post's uses cascade away, so an orphan cannot be traced to a post or an
 * author, and no hold table can name a reference. The evidence a moderated post needs is kept elsewhere
 * (`moderation_snapshots`, never reaped inside a year; its copy of the card metadata is the follow-up, taken at hide
 * time), so a reference row is shared third-party page metadata, an ordinary cache once past the floor. A NULL snapshot
 * is NOT a reason to keep a row (it is not a takedown marker).
 *
 * `FOR UPDATE SKIP LOCKED` so two sweeps never fight over a row. The FK from `post_references` has no cascade, so a use
 * inserted after the NOT EXISTS check makes the DELETE fail rather than lose data.
 */
import type { Client } from "pg";

/** An unused row untouched for less than this survives: one year, the retention floor. */
export const GC_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** One run's cap, so a backlog is finished over later runs and never one unbounded statement. */
export const GC_BATCH = 500;

/** Delete up to `limit` orphan references untouched for GC_RETENTION_MS at `now`. Returns how many were deleted. */
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
    [new Date(now.getTime() - GC_RETENTION_MS), limit],
  );
  return rowCount ?? 0;
}
