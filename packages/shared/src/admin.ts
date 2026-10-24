// SPDX-License-Identifier: MIT OR Apache-2.0
import { DISPUTE_EMAIL } from "./contact";
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

/**
 * #57 Q3: the durations a moderator may attach to a TEMPORARY content decision
 * (`keep_hidden` / `remove`). Same ladder as a suspension. ⚠️ It RECORDS the
 * intended end on the audit row only; nothing un-hides content at that time.
 */
export const DECISION_DURATION_HOURS = [24, 168, 720] as const;
export type DecisionDurationHours = (typeof DECISION_DURATION_HOURS)[number];

/**
 * #57 Art. 17 Q5: the structured GROUNDS a content decision may cite. Two
 * independent, optional fields. PROPOSED lists, pending attorney / CireSnave
 * review (docs/superpowers/specs/2026-10-14-art17-ground-enums.md). Single
 * source for the 0031 CHECKs, the route's validation and the admin form.
 */
export const LEGAL_GROUNDS = ["csam", "copyright_infringement", "illegal_content_other"] as const;
export type LegalGround = (typeof LEGAL_GROUNDS)[number];

/** Each value names the Community Guidelines clause (docs/legal/community-guidelines.md section 1) it maps to. */
export const CONTRACTUAL_GROUNDS = [
  "guidelines_threats_harassment", // clause 3
  "guidelines_hate_speech", // clause 4
  "guidelines_ncii", // clause 5
  "guidelines_doxxing", // clause 6
  "guidelines_spam", // clause 7
  "guidelines_malware_phishing", // clause 8
  "guidelines_impersonation", // clause 9
  "guidelines_ip", // clause 10
  "terms_other", // a Terms of Service breach not listed above
] as const;
export type ContractualGround = (typeof CONTRACTUAL_GROUNDS)[number];

/**
 * How each ground reads to the author in a decision notice (#57 Art. 17 follow-up).
 * ⚠️ #57 Q2: none of these names a report, a notice or a reporter. Provisional
 * wording, with the lists above, pending attorney / CireSnave review.
 */
export const LEGAL_GROUND_LABELS: Readonly<Record<LegalGround, string>> = {
  csam: "child sexual abuse material",
  copyright_infringement: "copyright infringement",
  illegal_content_other: "content that is illegal",
};

export const CONTRACTUAL_GROUND_LABELS: Readonly<Record<ContractualGround, string>> = {
  guidelines_threats_harassment: "Community Guidelines: threats and harassment",
  guidelines_hate_speech: "Community Guidelines: hate speech",
  guidelines_ncii: "Community Guidelines: non-consensual intimate imagery",
  guidelines_doxxing: "Community Guidelines: sharing private information",
  guidelines_spam: "Community Guidelines: spam",
  guidelines_malware_phishing: "Community Guidelines: malware and phishing",
  guidelines_impersonation: "Community Guidelines: impersonation",
  guidelines_ip: "Community Guidelines: intellectual property",
  terms_other: "a breach of our Terms of Service",
};

/** `POST /admin/decision`. */
export interface AdminDecisionRequest {
  readonly subject: "post" | "comment";
  readonly subjectId: string;
  readonly decision: AdminDecisionKind;
  readonly reason: string;
  readonly violationCategory?: string;
  readonly legalHold?: boolean;
  readonly legalHoldCategory?: string;
  /** Only for `keep_hidden` / `remove`; one of DECISION_DURATION_HOURS. Omitted = no recorded end. 400 INVALID_INPUT on a restore. */
  readonly durationHours?: DecisionDurationHours;
  /** #57 Q5. Only for `keep_hidden` / `remove`; 400 INVALID_INPUT on a restore. Shown to the author. */
  readonly legalGround?: LegalGround;
  /** #57 Q5. Only for `keep_hidden` / `remove`; 400 INVALID_INPUT on a restore. Shown to the author. */
  readonly contractualGround?: ContractualGround;
}

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
  /** Newest first, active and released (account-legal-hold spec §3 T3). */
  readonly holds: readonly AdminAccountHold[];
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

/**
 * A row in `GET /admin/dsa-notices` (Part of #113, Task 4) — every CONFIRMED,
 * unresolved DSA notice, mirroring apps/api/src/moderation/dsa-notices.ts's
 * `OpenDsaNotice`, with `Date`s as ISO strings (the shape after a JSON
 * round-trip).
 */
export interface AdminDsaNotice {
  id: string;
  kind: "post" | "comment";
  /** `null` once the target has been deleted by its author (addendum, 2026-10-01). */
  targetId: string | null;
  excerpt: string;
  /** Addendum (2026-10-01): true once `targetId` is `null` — see `/admin/dsa-notices/:id/close`. */
  contentDeleted: boolean;
  reason: string;
  statement: string;
  reporterName: string;
  reporterEmail: string;
  createdAt: string;
}

export interface AdminDsaNoticesResponse {
  notices: AdminDsaNotice[];
}

/**
 * A row in `GET /admin/notices/undelivered` (notice outbox PR 3): a moderation
 * notice that reached `undeliverable`. No body and no address: the subject line
 * and the account's handle only. ISO strings.
 */
export interface AdminUndeliveredNotice {
  readonly id: string;
  readonly kind: "author_decision" | "author_auto_hide" | "account_action" | "appeal_outcome" | "reporter_outcome";
  readonly actionId: string;
  readonly subject: string;
  readonly createdAt: string;
  readonly attempts: number;
  /** A failure CLASS (never a message, body or address), e.g. `recipient_refused`. */
  readonly lastError: string | null;
  /** The row is purged then; a never-delivered window closes with it. */
  readonly retainUntil: string;
  /** `null` for a reporter (no account). */
  readonly recipientHandle: string | null;
  /** False for a reporter row and for an anonymised or vanished recipient. */
  readonly resendable: boolean;
}

export interface AdminUndeliveredNoticesResponse {
  notices: AdminUndeliveredNotice[];
}

/** One row of an account's legal-hold history (account-legal-hold spec §2). ISO strings. */
export interface AdminAccountHold {
  readonly id: string;
  readonly category: LegalHoldCategoryWire;
  readonly reason: string;
  readonly imposedBy: string;
  readonly imposedAt: string;
  readonly releasedAt: string | null;
  readonly releasedBy: string | null;
  readonly releaseReason: string | null;
}

/** Spec §6/§11.2, adopted by the PM 2026-10-01: an action may be appealed for 30 days. */
export const APPEAL_WINDOW_DAYS = 30;

/**
 * Notice outbox PR 4: the window starts when the notice is DELIVERED, not when the
 * decision is made. A notice that is still undelivered after this long is given up
 * on (the retry schedule is about 2 days; this is the design's horizon). A link is
 * minted valid for horizon + window, then shortened to delivered_at + window once
 * the notice goes out (moderation/notice-outbox.ts).
 */
export const NOTICE_UNDELIVERABLE_HORIZON_DAYS = 7;

/**
 * #57 Q8=A: the ONE generic redress sentence appended to every ADVERSE decision
 * email (author keep_hidden/remove, account warn/suspend/ban). Names the three
 * routes generically: no body, no statute number. Plain language, not legal
 * advice. Shared by notify-author.ts and notify-account.ts so they cannot drift.
 */
export const REDRESS_SENTENCE =
  `If you disagree with this decision, you can contest it by emailing ${DISPUTE_EMAIL}. Besides an internal complaint (an appeal to us), you may also be able to use an out-of-court dispute settlement process or seek judicial redress. This is general information, not legal advice.`;

/**
 * #57 Q9: how long the rendered text of a moderation notice is kept, in days,
 * counted from the DECISION's created_at. CireSnave 2026-10-15 (notice outbox
 * design, Q2): "Make the configurable constant one year unless there is legal
 * reason to keep them longer." None was found. The purge
 * (src/moderation/notice-records.ts, src/moderation/notice-outbox.ts) deletes
 * rows past `retain_until`, which is fixed at write time, so a changed constant
 * applies to NEW records only. A later legal finding is this one number.
 */
export const MODERATION_NOTICE_RETENTION_DAYS = 365;

/**
 * #50 Q4 — a re-requested delete link (the "email me a new link" route) lives
 * this long. Short on purpose: the PM ruled against long-lived bearer tokens
 * sitting in old inboxes, and asking again is cheap.
 */
export const DELETE_REQUEST_RESEND_TTL_HOURS = 24;

/**
 * What can be appealed. ⚠️ NOT `user_terminate` — the CSAM path (#114), an
 * open legal question. Restores/appeal outcomes are not adverse, so not here.
 */
export const APPEALABLE_ACTIONS = [
  "content_keep_hidden",
  "content_remove",
  "user_warn",
  "user_suspend",
  "user_ban",
] as const;
export type AppealableAction = (typeof APPEALABLE_ACTIONS)[number];

/** What the appellant sees about the action they are appealing. */
export interface AppealTarget {
  readonly actionId: string;
  readonly action: AppealableAction;
  readonly reason: string;
  readonly createdAt: string;
  readonly alreadyAppealed: boolean;
  readonly windowClosesAt: string;
}

/** One open appeal in `GET /admin/appeals`, oldest first. ISO strings. */
export interface AdminAppeal {
  readonly id: string;
  /** The appellant's own text. */
  readonly body: string;
  readonly createdAt: string;
  readonly actionId: string;
  readonly action: AppealableAction;
  /** The original statement of reasons. */
  readonly actionReason: string;
  /** Who took the original action (spec decision #8: shown, so a second moderator can take it). */
  readonly actionActor: string;
  /** The appellant's CURRENT handle, or null if they have no profile. Never an email. */
  readonly appellantHandle: string | null;
  /** What the appealed action was taken against. */
  readonly subject: "post" | "comment" | "account";
  /** The post id, comment id or user id (by `subject`), for the moderator's link. */
  readonly targetId: string | null;
  /**
   * Task 7 addition: the shared type lacked what the admin page's link
   * needs for a comment appeal ("a comment to its post" — there is no
   * standalone comment permalink in this app) and didn't want a second
   * lookup for a post appeal either. Present only when `subject` is
   * `"post"` or `"comment"` — the post's (current) author handle and slug,
   * for `/${handle}/${slug}`. `null` when the post's author has no profile,
   * or when `subject` is `"account"` (use `appellantHandle` there instead:
   * the account acted against is always the appellant's own account — see
   * `fileAppeal`'s `appellantId` check in apps/api/src/moderation/appeals.ts).
   */
  readonly targetPostHandle: string | null;
  /** The post's slug, same presence rule as `targetPostHandle`. */
  readonly targetPostSlug: string | null;
}

/** `GET /admin/appeals`. */
export interface AdminAppealsResponse {
  readonly appeals: readonly AdminAppeal[];
}

/** `POST /admin/appeals/:id/resolve`. */
export interface AdminAppealResolveRequest {
  readonly decision: "grant" | "deny";
  /** Non-blank. Sent to the appellant as the reason. */
  readonly reason: string;
}

/** `POST /admin/appeals/:id/resolve`'s 200 body. */
export interface AdminAppealResolveResponse {
  readonly resolutionActionId: string;
  /** Spec decision #8's hedge made checkable: the resolver took the original action. Not refused. */
  readonly sameReviewer: boolean;
}
