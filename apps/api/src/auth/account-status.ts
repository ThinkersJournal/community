/**
 * IS THIS ACCOUNT BARRED FROM AUTHENTICATING RIGHT NOW?
 *
 * ⚠️ The `security_epoch` invalidates EXISTING sessions and does nothing about
 * new ones. This is the other half: it decides whether a NEW session may be
 * issued at all. Neither alone is a ban (issue #35).
 *
 * `disabled_at` is permanent (ban, or CSAM termination). `suspended_until` is
 * temporary and EXPIRES ON ITS OWN — a suspension whose time has passed bars
 * nothing, which is what makes it a suspension rather than a ban.
 *
 * ⚠️ Strict `>`, not `>=`, below: at the INSTANT `suspended_until` equals
 * `now`, the suspension has finished and the user is free — the boundary
 * itself belongs to freedom, not to the bar.
 */
import type { AccountBarredDetail } from "@thinkersjournal/shared";

import { errorResponse } from "../http/errors";

export interface AccountStatusRow {
  readonly suspended_until: Date | null;
  readonly disabled_at: Date | null;
}

export function isBarred(row: AccountStatusRow, now: Date = new Date()): boolean {
  if (row.disabled_at !== null) return true;
  if (row.suspended_until !== null && row.suspended_until.getTime() > now.getTime()) return true;
  return false;
}

/**
 * The 403 a barred account's own holder receives (#50 Q2). Call it ONLY after
 * `isBarred(row)` returned true — it describes the bar and does not decide it.
 *
 * ⚠️ DELIBERATELY TAKES NO `now`. Re-deciding here could disagree with the
 * caller's `isBarred` if a suspension lapses between the two calls, which
 * would leave this with nothing true to say. A ban wins over a suspension: it
 * is permanent, so "suspended until X" would be a false promise.
 */
export function accountBarredResponse(row: AccountStatusRow, headers: Record<string, string> = {}): Response {
  const barred: AccountBarredDetail =
    row.disabled_at === null && row.suspended_until !== null
      ? { kind: "suspended", until: row.suspended_until.toISOString() }
      : { kind: "banned" };
  return errorResponse("ACCOUNT_BARRED", 403, { barred, headers });
}
