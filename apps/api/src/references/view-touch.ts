// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.2d part 2: the view-time half of access-driven refresh (plan decision 22: "a view serves the last known state and
 * enqueues a refresh for next time; `next_check_at` tapers with `last_viewed_at`; an unviewed reference goes dormant and
 * wakes on its next view").
 *
 * A public read of a post calls `touchViewed` with the post's id. For every reference the post uses it records
 * `last_viewed_at`, and a DORMANT reference (`next_check_at` NULL, not gone) is made due now, so the next sweep tick claims
 * it through `claimDueRefreshes`. The write never moves an already scheduled `next_check_at` (a taper or a lease is not
 * pulled forward by a view) and never wakes a gone reference.
 *
 * Throttled: a reference viewed within `VIEW_TOUCH_MIN_MS` is skipped, so a busy post costs at most one write a minute per
 * reference instead of one per page view (public pages are also edge-cached).
 */
import type { Client } from "pg";

export const VIEW_TOUCH_MIN_MS = 60_000;

/** Returns how many reference rows were written. */
export async function touchViewed(db: Client, postIds: readonly string[], now: Date): Promise<number> {
  if (postIds.length === 0) return 0;
  const { rowCount } = await db.query(
    `UPDATE "references" r
        SET last_viewed_at = $2,
            next_check_at = CASE WHEN r.next_check_at IS NULL AND r.gone_at IS NULL THEN $2 ELSE r.next_check_at END
      WHERE r.id IN (SELECT pr.reference_id FROM post_references pr WHERE pr.post_id = ANY($1::uuid[]))
        AND (r.last_viewed_at IS NULL OR r.last_viewed_at < $3)`,
    [postIds, now, new Date(now.getTime() - VIEW_TOUCH_MIN_MS)],
  );
  return rowCount ?? 0;
}
