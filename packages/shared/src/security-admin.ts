import type { SecurityAlertSignal, SecurityAlertSubject, SignalClass } from "./security-alert";

/** `GET /admin/security/account-ref/:ref` (security-alerting spec §2.6 N6). Admin-only. */
export interface AdminSecurityRefResponse {
  readonly userId: string;
  /** The account's handle for `/admin/accounts/:handle`, or null when it has none any more. */
  readonly handle: string | null;
}

/** One stored held row, as the admin page lists it. `events`, `version` and `open` are data, never the order. */
export interface AdminHeldRow {
  readonly subjectKey: string;
  readonly signal: SecurityAlertSignal;
  readonly subject: SecurityAlertSubject;
  readonly events: number;
  readonly suppressed: number;
  readonly version: number;
  /** True while no delivered held-subject report has covered it. */
  readonly open: boolean;
}

/** `GET /admin/security/held?class=&after=`: one page, keyed on the immutable `subject_key` (F2). */
export interface AdminSecurityHeldResponse {
  readonly signalClass: SignalClass;
  readonly rows: readonly AdminHeldRow[];
  /** Pass as `after` for the next page of this class; null when the class is exhausted. */
  readonly nextAfter: string | null;
  /** The classes in `HELD_PRIORITY` order, so the page walks them in turn. */
  readonly classOrder: readonly SignalClass[];
}

/** Rows per admin page (§2.6). */
export const ADMIN_HELD_PAGE_SIZE = 200;
