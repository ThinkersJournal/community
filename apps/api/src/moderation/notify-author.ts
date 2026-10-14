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
import { withClient } from "../db/client";
import type { AutoHideResult } from "./auto-hide";
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

/**
 * Tell an author their content was auto-hidden pending review (#56).
 *
 * ⚠️ THE COPY IS FIXED. It names the author's own post title and nothing else:
 * never a reporter, a reason, a count, or the threshold (disclosing the
 * threshold hands an attacker the number). It carries NO appeal link: there is
 * no decision yet, and an appeal attaches to one. It says what is true: the
 * content is hidden pending review, a moderator will look, and the author will
 * be told the outcome (that notice carries the appeal link).
 *
 * Same stream as `sendModerationNotice` ("outbound", no unsubscribe): a user
 * cannot opt out of being told their content was actioned. NEVER THROWS.
 */
export async function sendAutoHideNotice(
  env: Env,
  to: string,
  notice: { readonly subject: "post" | "comment"; readonly postTitle: string },
): Promise<boolean> {
  const lead = "Your content has been hidden pending review.";
  const contentLine =
    notice.subject === "post"
      ? `This is about your post "${notice.postTitle}".`
      : `This is about your comment on "${notice.postTitle}".`;
  const next =
    "A moderator will review it, and we will tell you the outcome. This is not a final decision, so there is nothing to appeal yet. If a moderator decides to keep it hidden, that message will tell you how to appeal.";
  return await postmarkSend(env, {
    from: "noreply@thinkersjournal.com",
    to,
    subject: "Your content has been hidden pending review",
    textBody: `${lead}\n\n${contentLine}\n\n${next}`,
    htmlBody: `<p>${escapeHtml(lead)}</p><p>${escapeHtml(contentLine)}</p><p>${escapeHtml(next)}</p>`,
    stream: "outbound",
  });
}

interface AutoHideRecipient {
  email: string;
  anonymised_at: Date | null;
  title: string;
  deleted_at: Date | null;
  hidden_at: Date | null;
}

/**
 * The auto-hide notice, end to end: read the recipient NOW, decide, send.
 *
 * ⚠️ READ AT SEND TIME, ON `HYPERDRIVE_FRESH`, not carried through the report
 * request. A comment the author deleted, content a moderator restored, or an
 * account anonymised between the hide and this send must not be mailed, and
 * the sentinel address of an anonymised account must never reach Postmark.
 * One SELECT, one definition of "gone": `anonymised_at`, `deleted_at`, and
 * "still hidden" (`hidden_at`).
 *
 * ⚠️ NEVER THROWS, so `ctx.waitUntil(...)` cannot surface an error and a
 * report that was recorded is never undone by a mail or database failure. The
 * skip line carries the reason and the subject kind only: no address, title,
 * or id. It is a `warn`, the level the codebase's other "refused" lines use
 * (routes/media.ts), not `info`, which nothing else here emits.
 */
export async function notifyAutoHidden(env: Env, ctx: ExecutionContext, hidden: AutoHideResult): Promise<void> {
  try {
    const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } =
        hidden.subject === "post"
          ? await c.query<AutoHideRecipient>(
              `SELECT u.email, u.anonymised_at, p.title, NULL::timestamptz AS deleted_at, p.hidden_at
                 FROM posts p JOIN users u ON u.id = p.author_id
                WHERE p.id = $1`,
              [hidden.subjectId],
            )
          : await c.query<AutoHideRecipient>(
              `SELECT u.email, u.anonymised_at, p.title, c.deleted_at, c.hidden_at
                 FROM comments c JOIN users u ON u.id = c.author_id JOIN posts p ON p.id = c.post_id
                WHERE c.id = $1`,
              [hidden.subjectId],
            );
      return rows[0];
    });

    const skip = (reason: string): void => {
      console.warn("moderation notice skipped", { reason, subject: hidden.subject });
    };
    if (row === undefined) return skip("auto_hide_content_gone");
    if (row.anonymised_at !== null) return skip("auto_hide_author_anonymised");
    if (row.deleted_at !== null) return skip("auto_hide_comment_deleted");
    if (row.hidden_at === null) return skip("auto_hide_no_longer_hidden");

    const ok = await sendAutoHideNotice(env, row.email, { subject: hidden.subject, postTitle: row.title });
    if (!ok) console.error("auto-hide notice not sent", { subject: hidden.subject });
  } catch (err) {
    console.error("auto-hide notice failed", { err });
  }
}
