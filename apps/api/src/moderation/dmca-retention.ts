// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Erase the personal details of closed DMCA cases (ROADMAP R9; CireSnave decision
 * 298 A, 2026-10-25): three years after a case closes, the complainant's and the
 * author's name, address, phone, email and signature, and the free text that
 * describes the work and the material, are overwritten with a marker. The case id,
 * its dates, its state and the author's user id (the strike record) stay, so the
 * outcome can still be shown without anyone's details.
 *
 * "Closed" means: rejected, restored or withdrawn (from the date it was restored or
 * decided), or a takedown nobody counter-noticed (from the date the counter-notice
 * window ended). A pending notice, and a takedown still waiting out a
 * counter-notice, are open and are never erased.
 *
 * Idempotent: an erased row no longer matches (`complainant_email <> marker`). The
 * overwritten values satisfy the table's length CHECKs, so no migration is needed.
 * Run by the daily tick in src/index.ts.
 */
import { DMCA_PII_RETENTION_YEARS } from "@thinkersjournal/shared";

import { withClient } from "../db/client";
import { DMCA_COUNTER_WINDOW_DAYS } from "./dmca-counter";

export const ERASED_MARKER = "[erased]";

/** Caps one run's UPDATE, as the other reapers do. */
const ERASE_BATCH = 200;

export async function eraseClosedDmcaCases(env: Env, ctx: ExecutionContext): Promise<number> {
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `UPDATE dmca_notices SET
              complainant_email = $1, complainant_name = $1, complainant_address = $1, complainant_phone = $1,
              signature = $1, work_description = $1, target_label = $1
        WHERE id IN (
          SELECT id FROM dmca_notices
           WHERE complainant_email <> $1
             AND email_verified_at IS NOT NULL
             AND (
               (state IN ('rejected','restored','withdrawn')
                  AND COALESCE(restored_at, decided_at) < now() - make_interval(years => $2::int))
               OR (state = 'taken_down'
                  AND decided_at < now() - make_interval(years => $2::int) - make_interval(days => $3::int))
             )
           ORDER BY created_at
           LIMIT $4
        )
        RETURNING id`,
      [ERASED_MARKER, DMCA_PII_RETENTION_YEARS, DMCA_COUNTER_WINDOW_DAYS, ERASE_BATCH],
    );
    if (rows.length > 0) {
      await c.query(
        `UPDATE dmca_counter_notices SET author_name = $1, author_address = $1, author_phone = $1, signature = $1
          WHERE notice_id = ANY($2::uuid[])`,
        [ERASED_MARKER, rows.map((r) => r.id)],
      );
    }
    return rows.length;
  });
  if (n > 0) {
    console.log(`erase-closed-dmca-cases: erased ${n} case(s)`);
  }
  return n;
}
