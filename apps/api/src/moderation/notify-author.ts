/**
 * Tell an author their content was actioned (spec §7).
 *
 * ⚠️ THIS DOES NOT USE THE NOTIFICATION SYSTEM, DELIBERATELY. The `notifications`
 * table demands a human actor, forbids self-addressing, is suppressed by blocks
 * and is silenceable via preferences — all four are wrong for a due-process
 * notice. This sends direct transactional email on the "outbound" stream, the
 * same prefs-bypassing path as `sendVerificationEmail`.
 *
 * ⚠️ NOT the BROADCAST stream: that adds RFC 8058 one-click unsubscribe headers.
 * A user cannot opt out of being told they were actioned. That is correct — it
 * is a safety and due-process notice, not marketing.
 *
 * NEVER THROWS. A decision that already committed must not report failure
 * because Postmark was unreachable; `postmarkSend` logs the status.
 */
import { postmarkSend } from "../auth/postmark";
import { escapeHtml } from "../auth/email-verify";
import type { DecisionKind } from "./decide";

import { APPEAL_WINDOW_DAYS } from "@thinkersjournal/shared";

export interface ModerationNotice {
  readonly decision: DecisionKind;
  readonly wasHidden: boolean;
  readonly subject: "post" | "comment";
  readonly postTitle: string;
  readonly reason: string;
  /** #113 plan B. Omitted when the mint failed or the decision is `restore` — never rendered for a restore. */
  readonly appealUrl?: string;
}

interface Copy {
  readonly subject: string;
  readonly lead: string;
}

/**
 * Every (decision, visibility-before) pair that sends a notice. A Restore of
 * content that was never hidden is a dismissal and sends nothing, so it has
 * no copy — and the type says so, rather than an empty placeholder entry.
 */
type NoticeKey = Exclude<`${DecisionKind}:${boolean}`, "restore:false">;

const COPY: Readonly<Record<NoticeKey, Copy>> = {
  "restore:true": {
    subject: "Your content has been restored",
    lead: "We reviewed your content and restored it. It is visible again.",
  },
  "keep_hidden:true": {
    subject: "Your content remains hidden after review",
    lead: "We reviewed your content and it remains hidden because it does not meet our Community Guidelines.",
  },
  "keep_hidden:false": {
    subject: "Your content has been hidden after review",
    lead: "We reviewed a report about your content and have hidden it because it does not meet our Community Guidelines.",
  },
  "remove:true": {
    subject: "Your content has been removed",
    lead: "We reviewed your content and removed it because it does not meet our Community Guidelines.",
  },
  "remove:false": {
    subject: "Your content has been removed",
    lead: "We reviewed your content and removed it because it does not meet our Community Guidelines.",
  },
};

export async function sendModerationNotice(
  env: Env,
  to: string,
  notice: ModerationNotice,
): Promise<boolean> {
  // ⚠️ A Restore of content that was never hidden is a DISMISSAL: nothing was
  // done to the author, so nothing is sent. This is the ONLY place the rule
  // lives — the route calls this unconditionally. A second copy of the rule in
  // the caller would make each copy impossible to test on its own.
  if (notice.decision === "restore" && !notice.wasHidden) return true;

  // The early return above removed the one pair COPY has no entry for.
  const { subject, lead } = COPY[`${notice.decision}:${notice.wasHidden}` as NoticeKey];
  const contentLine =
    notice.subject === "post"
      ? `This is about your post "${notice.postTitle}".`
      : `This is about your comment on "${notice.postTitle}".`;

  // ⚠️ A `restore` NEVER renders the appeal link, even when a caller passes
  // one — there is nothing left to appeal once the content is back.
  const url = notice.decision === "restore" ? undefined : notice.appealUrl;
  const appealTextLine = url === undefined ? "" : `\nYou can appeal this decision within ${APPEAL_WINDOW_DAYS} days: ${url}`;
  const appealHtmlLine = url === undefined ? "" : `<p>You can appeal this decision within ${APPEAL_WINDOW_DAYS} days: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`;

  return await postmarkSend(env, {
    from: "noreply@thinkersjournal.com",
    to,
    subject,
    textBody: `${lead}\n\n${contentLine}\n\nReason given by the reviewer:\n\n${notice.reason}\n${appealTextLine}`,
    htmlBody: `<p>${escapeHtml(lead)}</p><p>${escapeHtml(contentLine)}</p><p><strong>Reason given by the reviewer:</strong></p><p>${escapeHtml(notice.reason)}</p>${appealHtmlLine}`,
    stream: "outbound",
  });
}
