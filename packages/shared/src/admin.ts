/**
 * Wire types + the one cross-Worker constant for the Cloudflare Access-gated
 * admin surface (M4 2b). A DIFFERENT trust domain from member sessions —
 * see apps/api/src/admin/require-admin.ts and admin/access-jwt.ts.
 */

/**
 * The header Cloudflare Access injects on a request that passed the edge
 * check, and the ONLY thing `requireAdmin` (apps/api/src/admin/require-admin.ts)
 * accepts as proof of admin identity. Shared here so the `web` Worker's
 * admin pages (which forward this header verbatim, never a Worker-held
 * credential) and the `api` Worker's gate read the identical literal —
 * this is the ONE name, not two copies that could drift.
 */
export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** `GET /admin/whoami` — the calling admin's own identity. */
export interface AdminIdentityWire {
  email: string;
  sub: string;
}

/** A row in `GET /admin/queue` — mirrors apps/api/src/moderation/queue.ts's
 * `QueueItem`, with `Date`s as ISO strings (the shape after a JSON round-trip). */
export interface AdminQueueItem {
  kind: "post" | "comment";
  targetId: string;
  excerpt: string;
  hiddenAt: string | null;
  reportCount: number;
  severityRank: number;
  oldestReportAt: string;
  authorHandle: string | null;
}

export interface AdminQueueResponse {
  items: AdminQueueItem[];
}

/** Mirrors `DECISIONS` in apps/api/src/routes/admin.ts. */
export const ADMIN_DECISIONS = ["restore", "keep_hidden", "remove"] as const;
export type AdminDecisionKind = (typeof ADMIN_DECISIONS)[number];

/** Mirrors `LEGAL_HOLD_CATEGORIES` in apps/api/src/routes/admin.ts. */
export const LEGAL_HOLD_CATEGORIES = ["csam", "dmca", "other"] as const;
export type LegalHoldCategoryWire = (typeof LEGAL_HOLD_CATEGORIES)[number];

/**
 * A row in `GET /admin/media-access-requests` — the two-person grant queue
 * (#61). `sha256` is derived from `r2_key` for DISPLAY ONLY; the two-person
 * check itself compares `requestedBy`/the viewer's own identity, never this.
 */
export interface AdminMediaAccessRequest {
  id: string;
  sha256: string;
  requestedBy: string;
  reason: string;
  createdAt: string;
}

export interface AdminMediaAccessRequestsResponse {
  requests: AdminMediaAccessRequest[];
}

/**
 * The two-person rule's "same hand?" test for Access identities — the JS
 * side of it (#98). Access emails are not case-normalized upstream, so
 * "Alice@x" approving "alice@x" is ONE hand, not two.
 *
 * The rule lives in four places that must agree: this function (used by the
 * admin UI's `isOwnRequest` and `GET /media/restricted`'s read-side
 * re-check), and two SQL copies that cannot import it — `approveMediaAccess`'s
 * `WHERE` and the 0016 `media_access_requests_distinct_hands` CHECK, both
 * `lower(trim(...))`. `SAME_ADMIN_HAND_CASES` below is run through all of
 * them (packages/shared/test/admin.test.ts for this function,
 * apps/api/test/media-restricted-route.test.ts for the SQL), so changing any
 * one copy's normalization fails a test.
 *
 * ⚠️ KNOWN, NOT REACHABLE: Postgres `trim()` strips SPACES only; JS `.trim()`
 * strips all whitespace. For an identity padded with a tab/newline this
 * function says "same hand" where the SQL says "two". That direction fails
 * CLOSED here (the UI hides Approve; the read side refuses to serve), and
 * both identities come from a verified Access JWT's `email` claim, never
 * user input. The table therefore holds only cases on which both sides
 * agree — do not add a non-space whitespace case without changing the SQL.
 */
export function sameAdminHand(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface SameAdminHandCase {
  readonly a: string;
  readonly b: string;
  /** true = one hand (a self-approval, refused); false = two distinct hands. */
  readonly same: boolean;
}

export const SAME_ADMIN_HAND_CASES: readonly SameAdminHandCase[] = [
  { a: "alice@example.test", b: "alice@example.test", same: true },
  { a: "Alice@Example.Test", b: "alice@example.test", same: true },
  { a: "  alice@example.test  ", b: "alice@example.test", same: true },
  { a: " ALICE@example.test", b: "alice@EXAMPLE.test ", same: true },
  { a: "alice@example.test", b: "bob@example.test", same: false },
  { a: "alice@example.test", b: "alice@example.org", same: false },
  { a: "alice+review@example.test", b: "alice@example.test", same: false },
  { a: "al ice@example.test", b: "alice@example.test", same: false },
];

/**
 * #113 plan A — the account actions a moderator can take from the admin UI.
 * ⚠️ `terminate` is deliberately NOT here: it is the CSAM path (#114), which
 * calls the primitive itself and has no admin button.
 */
export const ADMIN_ACCOUNT_ACTIONS = ["warn", "suspend", "ban"] as const;
export type AdminAccountActionKind = (typeof ADMIN_ACCOUNT_ACTIONS)[number];

/** Spec §11.2, adopted by the PM 2026-10-01: 24h / 7d / 30d, default 7d. */
export const SUSPENSION_HOURS = [24, 168, 720] as const;
export type SuspensionHours = (typeof SUSPENSION_HOURS)[number];
export const DEFAULT_SUSPENSION_HOURS: SuspensionHours = 168;

/** Spec §5/§11.2, adopted: an action older than this no longer escalates the ladder (it stays in the log). */
export const ESCALATION_WINDOW_MONTHS = 12;

/** A moderation-log row as the ladder sees it. */
export interface LadderEntry {
  readonly action: "user_warn" | "user_suspend" | "user_ban" | "user_terminate";
  /** False once the row is older than ESCALATION_WINDOW_MONTHS (it stays in the log). */
  readonly countsTowardEscalation: boolean;
}

/** A row in `GET /admin/accounts/:handle`'s history, newest first. */
export interface AdminAccountHistoryEntry extends LadderEntry {
  readonly id: string;
  readonly reason: string;
  readonly violationCategory: string | null;
  readonly actorAdmin: string;
  readonly createdAt: string;
  readonly actionExpiresAt: string | null;
}

/**
 * Where history alone points on the ladder (spec §5). ADVISORY: the moderator
 * decides, and a severe violation skips straight to ban. Shared so the admin
 * page and the api can never disagree about it.
 */
export function suggestNextRung(history: readonly LadderEntry[]): AdminAccountActionKind {
  const counted = history.filter((h) => h.countsTowardEscalation);
  if (counted.some((h) => h.action === "user_suspend" || h.action === "user_ban" || h.action === "user_terminate")) {
    return "ban";
  }
  if (counted.some((h) => h.action === "user_warn")) return "suspend";
  return "warn";
}

/** `GET /admin/accounts/:handle`. */
export interface AdminAccountResponse {
  readonly userId: string;
  readonly handle: string;
  readonly suspendedUntil: string | null;
  readonly disabledAt: string | null;
  /** 'ban' | 'terminate' | null — mirrors `users.disabled_reason`. Null when not disabled. */
  readonly disabledReason: string | null;
  readonly history: readonly AdminAccountHistoryEntry[];
  readonly suggestedNext: AdminAccountActionKind;
}

/** `POST /admin/accounts/:handle/actions`. */
export interface AdminAccountActionRequest {
  readonly action: AdminAccountActionKind;
  readonly reason: string;
  readonly violationCategory?: string;
  /** Only for `suspend`; must be one of SUSPENSION_HOURS. Defaults to DEFAULT_SUSPENSION_HOURS. */
  readonly suspensionHours?: number;
  /** Only for `ban`; must be `true` or the route 400s INVALID_INPUT — a ban is permanent. */
  readonly confirmBan?: boolean;
}
