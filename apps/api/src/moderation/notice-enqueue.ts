/**
 * Render the author's decision notice and INSERT it into the notice outbox,
 * INSIDE the decision's own transaction (notice outbox design, section 4).
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
import { mintAppealUrl } from "./notice-links";
import { renderModerationNotice } from "./notify-author";

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

  // retain_until counts from the DECISION's created_at. The fallback to now()
  // is only for an action row that cannot be read (never expected: it was
  // written in this transaction).
  await c.query(
    `INSERT INTO moderation_notice_outbox
            (action_id, kind, recipient_user_id, subject, body_text, body_html, retain_until)
     VALUES ($1, 'author_decision', $2, $3, $4, $5,
             COALESCE((SELECT created_at FROM moderation_actions WHERE id = $1), now())
               + make_interval(days => $6::int))
     ON CONFLICT (action_id, kind) DO NOTHING`,
    [input.actionId, input.authorId, rendered.subject, rendered.textBody, rendered.htmlBody, MODERATION_NOTICE_RETENTION_DAYS],
  );
  return true;
}
