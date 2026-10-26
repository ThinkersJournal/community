// SPDX-License-Identifier: MIT OR Apache-2.0
import { z } from 'zod';

/**
 * A DMCA takedown notice (17 U.S.C. §512(c)(3)(A); design note
 * docs/superpowers/specs/2026-10-25-dmca-flow-design.md). Unauthenticated: the
 * complainant proves a working inbox by confirming, as a DSA reporter does.
 *
 * The six elements: (i) signature, (ii) the work, (iii) the material and where
 * it is, (iv) contact details, (v) good-faith statement, (vi) accuracy and
 * authority under penalty of perjury. The two statements must be literally
 * `true`; their wording lives on the form and in docs/legal/dmca-policy.md.
 */
export const DmcaNoticeInput = z
  .object({
    postId: z.string().uuid().optional(),
    commentId: z.string().uuid().optional(),
    /** The exact address of a post, resolved by the api to a `postId` (never stored). */
    contentUrl: z.string().trim().min(1).max(2048).optional(),
    workDescription: z.string().trim().min(1).max(5000),
    complainantName: z.string().trim().min(1).max(200),
    complainantEmail: z.email().max(254).toLowerCase(),
    complainantAddress: z.string().trim().min(1).max(500),
    complainantPhone: z.string().trim().min(1).max(50),
    signature: z.string().trim().min(1).max(200),
    statementGoodFaith: z.literal(true),
    statementAccuracy: z.literal(true),
    turnstileToken: z.string().min(1),
  })
  .refine(
    (t) => [t.postId, t.commentId, t.contentUrl].filter((v) => v !== undefined).length === 1,
    { message: 'exactly one of postId/commentId/contentUrl' },
  );
export type DmcaNoticeInputT = z.infer<typeof DmcaNoticeInput>;

/**
 * Placeholders for the attorney (design note section 2). Changing one is a code
 * change reviewed like any other; none is stored per row.
 */
export const DMCA_CONFIRM_WINDOW_DAYS = 7;

/**
 * A row in `GET /admin/dmca-notices`: a CONFIRMED notice awaiting a moderator
 * (apps/api/src/moderation/dmca-decisions.ts `OpenDmcaNotice`, with `Date`s as ISO
 * strings). Carries the complainant's contact details and statements because the
 * moderator decides on them; this surface is Access-gated.
 */
export interface AdminDmcaNotice {
  id: string;
  kind: 'post' | 'comment';
  /** `null` once the target was deleted by its author: only a rejection is possible. */
  targetId: string | null;
  excerpt: string;
  contentDeleted: boolean;
  workDescription: string;
  complainantName: string;
  complainantEmail: string;
  complainantAddress: string;
  complainantPhone: string;
  signature: string;
  createdAt: string;
  /** Takedowns of this author that stand in the strike window, for the repeat-infringer record. */
  authorStrikes: number;
  /** `authorStrikes` has reached the threshold: a prompt for a moderator, never an action. */
  authorFlagged: boolean;
}

export interface AdminDmcaNoticesResponse {
  notices: AdminDmcaNotice[];
  /** Standing takedowns, those waiting out the restore wait first. */
  counters: AdminDmcaCounter[];
}

/**
 * The author's counter-notice (§512(g)(3)). The credential is the single-use
 * `token` from the takedown email, so no Turnstile and no account. The two
 * statements must be literally `true`; the wording is on the form.
 */
export const DmcaCounterInput = z.object({
  token: z.string().min(1).max(200),
  authorName: z.string().trim().min(1).max(200),
  authorAddress: z.string().trim().min(1).max(500),
  authorPhone: z.string().trim().min(1).max(50),
  signature: z.string().trim().min(1).max(200),
  statementMistake: z.literal(true),
  consentJurisdiction: z.literal(true),
});
export type DmcaCounterInputT = z.infer<typeof DmcaCounterInput>;

/** A standing takedown (or one waiting out the restore wait), as `GET /admin/dmca-notices` returns it (ISO strings). */
export interface AdminDmcaCounter {
  id: string;
  kind: 'post' | 'comment';
  label: string;
  complainantName: string;
  state: 'taken_down' | 'counter_received';
  decidedAt: string;
  counterReceivedAt: string | null;
  restoreAfter: string | null;
  claimantSuedAt: string | null;
}

/**
 * The repeat-infringer record (CireSnave decision 298 A, 2026-10-25): a count of an
 * author's standing takedowns in a rolling window, FLAGGED at the threshold for a
 * moderator to weigh. Nothing terminates an account automatically; termination is
 * the moderator's `terminate` action (policy docs/legal/dmca-policy.md section 4).
 */
export const DMCA_STRIKE_THRESHOLD = 3;
export const DMCA_STRIKE_WINDOW_MONTHS = 12;

/** How long a closed case keeps the complainant's and author's personal details (decision 298 A). */
export const DMCA_PII_RETENTION_YEARS = 3;

/** An author's DMCA record, as the admin account page shows it. */
export interface DmcaStrikes {
  /** Takedowns in the window that have not been restored, withdrawn or rejected. */
  readonly standing: number;
  readonly threshold: number;
  readonly windowMonths: number;
  /** `standing >= threshold`: a prompt for a person, never an action. */
  readonly flagged: boolean;
}
