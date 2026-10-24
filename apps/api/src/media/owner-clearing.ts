// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Media ownership records on anonymisation (design:
 * docs/superpowers/specs/2026-10-16-media-ownership-records-design.md).
 *
 * Anonymising an account clears `media.owner_id` on its uploads and stamps
 * `owner_cleared_at` (migration 0035). Everything else on the row stays: the
 * object key, `sha256`, the original-upload hashes (`original_md5/sha1/sha256`,
 * kept permanently), `pdq*`, the scan columns, sizes and `created_at`.
 *
 * Two callers share ONE rule, so it lives once, in `NOT_UNDER_OBJECT_HOLD`:
 *   - `clearMediaOwnerForAnonymisedUser`: inside the anonymisation transaction
 *     (src/auth/anonymise-accounts.ts), for the account being scrubbed.
 *   - `clearMediaOwnersOfAnonymisedUsers` / `sweepMediaOwners`: the bounded,
 *     idempotent daily sweep. It is the backfill for accounts anonymised before
 *     0035 and the catch-up after a per-object hold is released.
 *
 * ⚠️ THE HOLD RULE IS A DELIBERATE DEFAULT, NOT A LEGAL CONCLUSION. A row is NOT
 * cleared while a `media_legal_holds` row (0016) exists on its `r2_key`: the
 * owner link of a held object may itself be the evidence. Whether the link may
 * lawfully be KEPT after the account is anonymised (GDPR Art. 17(3)(b)/(e);
 * 18 U.S.C. 2258A preservation) is an OPEN QUESTION for CireSnave and the
 * attorney (design section 6, Q1). If the answer changes, change this one
 * constant. Holds are per r2_key, but a decision is per ROW: two users' rows on
 * the same (deduplicated) key are each judged on their own owner.
 *
 * `sweepMediaOwners` (the Worker-facing wrapper) is in ./owner-sweep.ts, so this module stays free
 * of Worker types and the Node test project can import it.
 *
 * Logs carry counts only, never user ids, keys or addresses.
 */
import type { Client } from "pg";

/**
 * Caps one sweep run's UPDATE — same reasoning as reap-orphan-media.ts's
 * REAP_BATCH: a large backlog is finished over the next runs, never in one
 * unbounded statement.
 */
export const SWEEP_BATCH = 500;

/**
 * THE HOLD RULE (see the header). A predicate over a `media` row that must be
 * in scope as the unaliased table name `media` in the statement using it.
 */
const NOT_UNDER_OBJECT_HOLD = `NOT EXISTS (SELECT 1 FROM media_legal_holds h WHERE h.r2_key = media.r2_key)`;

/**
 * Clear the ownership link of every non-held upload of `userId`. Call it in the
 * transaction that anonymises the account, after the guarded `users` UPDATE
 * reported a change. Returns the number of rows cleared.
 */
export async function clearMediaOwnerForAnonymisedUser(c: Client, userId: string): Promise<number> {
  const { rowCount } = await c.query(
    `UPDATE media
        SET owner_id = NULL, owner_cleared_at = now()
      WHERE owner_id = $1
        AND ${NOT_UNDER_OBJECT_HOLD}`,
    [userId],
  );
  return rowCount ?? 0;
}

/**
 * One bounded sweep batch: clear the non-held rows still owned by an
 * ALREADY-anonymised user. Idempotent: once a row's owner is NULL it no longer
 * matches, so a second run over the same data clears nothing and returns 0.
 * Oldest rows first (`id` is a uuidv7). Returns the number of rows cleared.
 */
export async function clearMediaOwnersOfAnonymisedUsers(c: Client, limit = SWEEP_BATCH): Promise<number> {
  const { rowCount } = await c.query(
    `UPDATE media
        SET owner_id = NULL, owner_cleared_at = now()
      WHERE id IN (
              SELECT id FROM media
               WHERE owner_id IN (SELECT u.id FROM users u WHERE u.anonymised_at IS NOT NULL)
                 AND ${NOT_UNDER_OBJECT_HOLD}
               ORDER BY id
               LIMIT $1
            )`,
    [limit],
  );
  return rowCount ?? 0;
}
