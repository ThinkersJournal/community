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
import type { Client } from "pg";

import { errorResponse } from "../http/errors";

export interface AccountStatusRow {
  readonly suspended_until: Date | null;
  readonly disabled_at: Date | null;
  /** 'ban' | 'terminate' | null. Optional so existing isBarred callers need no change. */
  readonly disabled_reason?: string | null;
}

export function isBarred(row: AccountStatusRow, now: Date = new Date()): boolean {
  if (row.disabled_at !== null) return true;
  if (row.suspended_until !== null && row.suspended_until.getTime() > now.getTime()) return true;
  return false;
}

/**
 * The statement of reasons for the bar now in force (#113): the newest
 * user_ban (if banned) or user_suspend (if suspended) row. ⚠️ NEVER for a
 * terminated account (#114). Called ONLY on the already-barred path, so a
 * normal login pays nothing.
 *
 * ⚠️ THE TERMINATE EXCLUSION IS ENFORCED TWICE, IN-MEMORY AND IN THE QUERY.
 * The in-memory `row.disabled_reason === "terminate"` check is only as good
 * as the caller's `row` — `AccountStatusRow.disabled_reason` is OPTIONAL (see
 * that interface's own comment: "so existing isBarred callers need no
 * change"), so a caller that builds `row` from a narrower SELECT, or re-reads
 * it fresh without that column, silently omits the field rather than failing
 * to compile — and `undefined !== "terminate"` lets the in-memory guard fall
 * through. The `NOT EXISTS` below re-derives the same fact from the row's
 * OWN id, independent of whatever the caller happened to pass, so a #114
 * reason never leaks even when the in-memory check is defeated this way.
 */
export async function loadBarReason(c: Client, userId: string, row: AccountStatusRow): Promise<string | null> {
  if (row.disabled_reason === "terminate") return null;
  const action = row.disabled_at !== null ? "user_ban" : "user_suspend";
  const { rows } = await c.query<{ reason: string }>(
    `SELECT reason FROM moderation_actions
      WHERE subject_user_id = $1 AND action = $2
        AND NOT EXISTS (SELECT 1 FROM users WHERE id = $1 AND disabled_reason = 'terminate')
      ORDER BY created_at DESC LIMIT 1`,
    [userId, action],
  );
  return rows[0]?.reason ?? null;
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
export function accountBarredResponse(
  row: AccountStatusRow,
  headers: Record<string, string> = {},
  reason: string | null = null,
): Response {
  const barred: AccountBarredDetail =
    row.disabled_at === null && row.suspended_until !== null
      ? { kind: "suspended", until: row.suspended_until.toISOString(), ...(reason !== null && { reason }) }
      : { kind: "banned", ...(reason !== null && { reason }) };
  return errorResponse("ACCOUNT_BARRED", 403, { barred, headers });
}
