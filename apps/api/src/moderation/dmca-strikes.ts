// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The repeat-infringer RECORD (ROADMAP R9; CireSnave decision 298 A, 2026-10-25;
 * policy docs/legal/dmca-policy.md section 4): how many takedowns of an author
 * stand inside a rolling window, and whether that has reached the threshold.
 *
 * ⚠️ A COUNT AND A FLAG, NEVER AN ACTION. Nothing in this module (or anywhere)
 * warns, suspends or terminates an account because of a count; a moderator reads
 * the record on the account page and decides. That is what §512(i) asks for ("a
 * policy that provides for the termination in appropriate circumstances") and what
 * the policy text promises.
 *
 * A takedown stands while its notice is `taken_down` or `counter_received`; a
 * restored, withdrawn or rejected notice does not count. The window runs from the
 * takedown (`decided_at`).
 */
import type { Client } from "pg";

import { DMCA_STRIKE_THRESHOLD, DMCA_STRIKE_WINDOW_MONTHS, type DmcaStrikes } from "@thinkersjournal/shared";

export function strikesFrom(standing: number): DmcaStrikes {
  return {
    standing,
    threshold: DMCA_STRIKE_THRESHOLD,
    windowMonths: DMCA_STRIKE_WINDOW_MONTHS,
    flagged: standing >= DMCA_STRIKE_THRESHOLD,
  };
}

/**
 * The SQL predicate both readers share: one definition of "stands, inside the
 * window". Unqualified column names, so a reader that aliases the table qualifies
 * them with `standingStrikeSql("s")`.
 */
export function standingStrikeSql(alias?: string): string {
  const p = alias === undefined ? "" : `${alias}.`;
  return `${p}state IN ('taken_down','counter_received')
  AND ${p}decided_at > now() - make_interval(months => ${DMCA_STRIKE_WINDOW_MONTHS})`;
}

export async function loadDmcaStrikes(c: Client, userId: string): Promise<DmcaStrikes> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM dmca_notices WHERE subject_user_id = $1 AND ${standingStrikeSql()}`,
    [userId],
  );
  return strikesFrom(Number(rows[0]?.n ?? "0"));
}
