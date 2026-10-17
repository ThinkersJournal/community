/**
 * Render a moderation notice and INSERT it into the notice outbox, INSIDE the
 * decision's own transaction (notice outbox design, section 4). One entry
 * point per kind: author decision, account action, appeal outcome, reporter
 * outcome.
 *
 * ⚠️ TRANSACTION-NEUTRAL, like applyDecisionInTx: no BEGIN, COMMIT, ROLLBACK or
 * try/catch. A mint, render or INSERT failure propagates to whoever owns the
 * transaction and ROLLS THE DECISION BACK. That is deliberate: a decision that
 * cannot be announced is the exact DSA Art. 17 failure the outbox closes, so it
 * must not be swallowed here.
 *
 * ⚠️ The appeal token is minted in the same transaction, with the same TTL as
 * `noticeLinks` (APPEAL_WINDOW_DAYS from the decision). Starting the window at
 * delivery is a later PR; nothing here reads or writes `delivered_at`.
 *
 * ⚠️ The caller decides WHETHER to enqueue (an anonymised author or a
 * tombstoned comment is skipped before this is called, so no token is minted
 * for a message nobody can receive). Whether there is anything to SAY is
 * decided by `renderModerationNotice` alone (a Restore of never-hidden content
 * renders `null`, and nothing is minted or queued).
 */
import type { Client } from "pg";

import { MODERATION_NOTICE_RETENTION_DAYS } from "@thinkersjournal/shared";

import type { DecisionKind } from "./decide";
import { mintAppealUrl, mintNoticeLinks } from "./notice-links";
import { renderAccountActionNotice, renderTerminationNotice } from "./notify-account";
import { renderAppealOutcomeNotice } from "./notify-appeal";
import { renderModerationNotice, type RenderedNotice } from "./notify-author";
import { renderDsaOutcome } from "./notify-reporter";

export interface AuthorDecisionNoticeInput {
  readonly actionId: string;
  readonly authorId: string;
  readonly decision: DecisionKind;
  readonly wasHidden: boolean;
  readonly subject: "post" | "comment";
  readonly postTitle: string;
  readonly reason: string;
  /** The verification-link origin, computed from the request (`verificationLinkOrigin`). */
  readonly origin: string;
}

/** Returns true when a row was offered to the outbox, false when there was nothing to say. */
export async function enqueueAuthorDecisionNotice(c: Client, input: AuthorDecisionNoticeInput): Promise<boolean> {
  // A restore has nothing left to appeal: no mint.
  const appealUrl =
    input.decision === "restore" ? null : await mintAppealUrl(c, input.origin, { actionId: input.actionId, userId: input.authorId });

  const rendered = renderModerationNotice({
    decision: input.decision,
    wasHidden: input.wasHidden,
    subject: input.subject,
    postTitle: input.postTitle,
    reason: input.reason,
    appealUrl: appealUrl ?? undefined,
  });
  if (rendered === null) return false;

  await insertOutbox(c, { actionId: input.actionId, kind: "author_decision", recipientUserId: input.authorId, rendered });
  return true;
}

interface OutboxInsert {
  readonly actionId: string;
  readonly kind: "author_decision" | "account_action" | "appeal_outcome" | "reporter_outcome";
  readonly recipientUserId?: string;
  /** A DSA reporter only (no account); nulled once the row settles. */
  readonly recipientEmail?: string;
  /** The DSA notice a reporter row answers (one ruling can answer several). */
  readonly dsaNoticeId?: string;
  readonly rendered: RenderedNotice;
}

/**
 * ⚠️ retain_until counts from the DECISION's created_at. The fallback to now()
 * is only for an action row that cannot be read (never expected: it was
 * written in this transaction).
 *
 * ⚠️ A bare `ON CONFLICT DO NOTHING`: the arbiters are the two partial unique
 * indexes of 0036 (one row per (action, kind), or per (action, kind, DSA
 * notice) for a reporter), and a retried enqueue is a no-op under either.
 */
async function insertOutbox(c: Client, row: OutboxInsert): Promise<void> {
  await c.query(
    `INSERT INTO moderation_notice_outbox
            (action_id, kind, recipient_user_id, recipient_email, dsa_notice_id, subject, body_text, body_html, retain_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             COALESCE((SELECT created_at FROM moderation_actions WHERE id = $1), now())
               + make_interval(days => $9::int))
     ON CONFLICT DO NOTHING`,
    [
      row.actionId,
      row.kind,
      row.recipientUserId ?? null,
      row.recipientEmail ?? null,
      row.dsaNoticeId ?? null,
      row.rendered.subject,
      row.rendered.textBody,
      row.rendered.htmlBody,
      MODERATION_NOTICE_RETENTION_DAYS,
    ],
  );
}

export interface AccountActionNoticeInput {
  readonly actionId: string;
  readonly userId: string;
  readonly kind: "warn" | "suspend" | "ban";
  readonly reason: string;
  /** The EFFECTIVE end of a suspension (the notice names it). */
  readonly suspendedUntil?: Date;
  readonly origin: string;
}

/**
 * Queue the account-action notice (kind 3). The caller skips an anonymised
 * account before calling, so no token is minted for a message nobody can
 * receive. A `terminate` has its own entry, `enqueueTerminationNotice`: its
 * notice carries no reason and no links (#114).
 */
export async function enqueueAccountActionNotice(c: Client, input: AccountActionNoticeInput): Promise<void> {
  // ⚠️ userId is the ACTIONED account, never the admin.
  const links = await mintNoticeLinks(c, input.origin, {
    actionId: input.actionId,
    userId: input.userId,
    bars: input.kind !== "warn",
  });
  const rendered = renderAccountActionNotice({
    kind: input.kind,
    reason: input.reason,
    suspendedUntil: input.suspendedUntil,
    appealUrl: links.appealUrl,
    deleteRequestUrl: links.deleteRequestUrl,
  });
  await insertOutbox(c, { actionId: input.actionId, kind: "account_action", recipientUserId: input.userId, rendered });
}

/**
 * Queue the termination notice (kind 3, #114 ruling). It takes NO reason,
 * evidence or link, mints NO token (a terminate is never appealable and offers no
 * deletion request), and goes through the same outbox as every account notice, so
 * the row is the record of what was sent. The caller skips an anonymised account.
 */
export async function enqueueTerminationNotice(c: Client, input: { readonly actionId: string; readonly userId: string }): Promise<void> {
  await insertOutbox(c, {
    actionId: input.actionId,
    kind: "account_action",
    recipientUserId: input.userId,
    rendered: renderTerminationNotice(),
  });
}

export interface AppealOutcomeNoticeInput {
  /** The appeal's RESOLUTION action (`appeal_granted` / `appeal_denied`), not the appealed one. */
  readonly resolutionActionId: string;
  readonly appellantId: string;
  readonly outcome: "granted" | "denied";
  readonly reason: string;
}

/**
 * Queue the appellant's outcome (kind 4). Returns false, queueing nothing, for
 * an anonymised or vanished appellant (B3: never mail a scrubbed account).
 */
export async function enqueueAppealOutcomeNotice(c: Client, input: AppealOutcomeNoticeInput): Promise<boolean> {
  const { rowCount } = await c.query(`SELECT 1 FROM users WHERE id = $1 AND anonymised_at IS NULL`, [input.appellantId]);
  if ((rowCount ?? 0) === 0) return false;
  await insertOutbox(c, {
    actionId: input.resolutionActionId,
    kind: "appeal_outcome",
    recipientUserId: input.appellantId,
    rendered: renderAppealOutcomeNotice({ outcome: input.outcome, reason: input.reason }),
  });
  return true;
}

export interface ReporterOutcomeNoticesInput {
  readonly actionId: string;
  readonly reporters: ReadonlyArray<{ readonly email: string; readonly noticeId: string }>;
  readonly decision: DecisionKind;
  readonly reason: string;
  readonly subject: "post" | "comment";
  readonly postTitle: string;
}

/**
 * Queue one outcome per DSA notice the ruling resolved (kind 5). The reporter
 * is owed an answer whatever became of the author's account (Art. 16(5)/17),
 * so nothing here is gated on `noticeSkip`. The address is stored on the row
 * (a reporter has no account) and nulled when the row settles.
 */
export async function enqueueReporterOutcomeNotices(c: Client, input: ReporterOutcomeNoticesInput): Promise<void> {
  const rendered = renderDsaOutcome({
    decision: input.decision,
    reason: input.reason,
    subject: input.subject,
    postTitle: input.postTitle,
  });
  for (const r of input.reporters) {
    await insertOutbox(c, {
      actionId: input.actionId,
      kind: "reporter_outcome",
      recipientEmail: r.email,
      dsaNoticeId: r.noticeId,
      rendered,
    });
  }
}
