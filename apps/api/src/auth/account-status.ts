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
 */
export interface AccountStatusRow {
  readonly suspended_until: Date | null;
  readonly disabled_at: Date | null;
}

export function isBarred(row: AccountStatusRow, now: Date = new Date()): boolean {
  if (row.disabled_at !== null) return true;
  if (row.suspended_until !== null && row.suspended_until.getTime() > now.getTime()) return true;
  return false;
}
