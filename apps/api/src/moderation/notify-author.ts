// SPDX-License-Identifier: MIT OR Apache-2.0
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
import { CANONICAL_ORIGIN, escapeHtml } from "../auth/email-verify";
import { withClient } from "../db/client";
import type { AutoHideResult } from "./auto-hide";
import type { DecisionKind } from "./decide";

import { APPEAL_WINDOW_DAYS, DISPUTE_CONTACT_LINE, GUIDELINES_PATH, GUIDELINES_VERSION, REDRESS_SENTENCE } from "@thinkersjournal/shared";

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

/** Exported for the regression test that no author-facing copy names a report, notice or reporter (#57 Q2). */
export const COPY: Readonly<Record<NoticeKey, Copy>> = {
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
    // ⚠️ #57 Q2: never says what prompted the review (a report, a notice) or by
    // whom. Same plain wording as the other leads.
    lead: "We reviewed your content and have hidden it because it does not meet our Community Guidelines.",
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

/**
 * The line that points an actioned member at the published Guidelines, naming
 * the version in force when the notice is sent. Shared with notify-account.ts.
 * ⚠️ #57 Q2: says nothing about what prompted a review. The URL is built on
 * `CANONICAL_ORIGIN`, never a request-derived host (see email-verify.ts).
 * Used only where the lead itself names the Community Guidelines.
 */
export function guidelinesLine(): { readonly text: string; readonly url: string } {
  const url = `${CANONICAL_ORIGIN}${GUIDELINES_PATH}`;
  return { text: `You can read our Community Guidelines (version ${GUIDELINES_VERSION}): ${url}`, url };
}

/** The strings actually handed to Postmark, for the #57 Q9 record. */
export interface RenderedNotice {
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}

/**
 * Render the author's decision notice. PURE: no I/O, no clock.
 *
 * Returns `null` for a Restore of content that was never hidden: that is a
 * DISMISSAL, nothing was done to the author, so there is nothing to send or to
 * queue. This is the ONLY place the rule lives — `sendModerationNotice` and the
 * outbox enqueue (notice-enqueue.ts) both call this. A second copy of the rule
 * in a caller would make each copy impossible to test on its own.
 *
 * Every rendered notice, with or without an appeal link, ends with
 * `DISPUTE_CONTACT_LINE` (notice outbox design F4).
 */
export function renderModerationNotice(notice: ModerationNotice): RenderedNotice | null {
  if (notice.decision === "restore" && !notice.wasHidden) return null;

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

  // #57 Q8=A: the redress sentence rides every ADVERSE notice (never a restore),
  // BEFORE the appeal line so it still appears when the appeal link is absent.
  const adverse = notice.decision !== "restore";
  const redressText = adverse ? `
${REDRESS_SENTENCE}
` : "";
  const redressHtml = adverse ? `<p>${escapeHtml(REDRESS_SENTENCE)}</p>` : "";

  // Only a lead that names the Guidelines (keep_hidden / remove) links to them.
  const guidelines = guidelinesLine();
  const namesGuidelines = lead.includes("Community Guidelines");
  const guidelinesText = namesGuidelines ? `
${guidelines.text}
` : "";
  const guidelinesHtml = namesGuidelines
    ? `<p>You can read our Community Guidelines (version ${escapeHtml(GUIDELINES_VERSION)}): <a href="${escapeHtml(guidelines.url)}">${escapeHtml(guidelines.url)}</a></p>`
    : "";

  return {
    subject,
    textBody: `${lead}

${contentLine}

Reason given by the reviewer:

${notice.reason}
${guidelinesText}${redressText}${appealTextLine}
${DISPUTE_CONTACT_LINE}`,
    htmlBody: `<p>${escapeHtml(lead)}</p><p>${escapeHtml(contentLine)}</p><p><strong>Reason given by the reviewer:</strong></p><p>${escapeHtml(notice.reason)}</p>${guidelinesHtml}${redressHtml}${appealHtmlLine}<p>${escapeHtml(DISPUTE_CONTACT_LINE)}</p>`,
  };
}

/**
 * @param onSent #57 Q9 — called with the EXACT strings sent, only when Postmark
 *   accepted them. Best-effort: a throw or rejection is swallowed here, so
 *   storing the record can never fail or block the notice.
 */
export async function sendModerationNotice(
  env: Env,
  to: string,
  notice: ModerationNotice,
  onSent?: (rendered: RenderedNotice) => Promise<void>,
): Promise<boolean> {
  const rendered = renderModerationNotice(notice);
  // A dismissal sends nothing (see renderModerationNotice).
  if (rendered === null) return true;
  const sent = await postmarkSend(env, { from: "noreply@thinkersjournal.com", to, ...rendered, stream: "outbound" });
  if (sent && onSent !== undefined) {
    try {
      await onSent(rendered);
    } catch {
      // Best-effort by contract; the caller logs with the action id.
    }
  }
  return sent;
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

    const warnSkipped = (reason: string): void => {
      console.warn("moderation notice skipped", { reason, subject: hidden.subject });
    };
    if (row === undefined) {
      warnSkipped("auto_hide_content_gone");
      return;
    }
    const reason =
      row.anonymised_at !== null
        ? "auto_hide_author_anonymised"
        : row.deleted_at !== null
          ? "auto_hide_comment_deleted"
          : row.hidden_at === null
            ? "auto_hide_no_longer_hidden"
            : null;
    if (reason !== null) {
      warnSkipped(reason);
      return;
    }

    const ok = await sendAutoHideNotice(env, row.email, { subject: hidden.subject, postTitle: row.title });
    if (!ok) console.error("auto-hide notice not sent", { subject: hidden.subject });
  } catch (err) {
    console.error("auto-hide notice failed", { err });
  }
}
