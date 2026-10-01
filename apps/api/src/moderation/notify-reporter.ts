/**
 * Tell a DSA notice's REPORTER the outcome of the decision they reported
 * (spec §8, DSA Art. 17-style statement of reasons to the notifier).
 *
 * ⚠️ SAME TRANSPORT AND NEVER-THROW DISCIPLINE AS `notify-author.ts`: direct
 * transactional email on the "outbound" stream (never BROADCAST — no
 * unsubscribe header belongs on a due-process notice), and this NEVER THROWS.
 * A decision that already committed, and whose DSA notices are already
 * resolved in the same transaction, must not report failure because Postmark
 * was unreachable; `postmarkSend` logs the status and the caller logs a
 * re-sendable failure keyed by noticeId/actionId (see routes/admin.ts).
 *
 * ⚠️ NO APPEAL LINK, and not merely because /appeal doesn't exist yet
 * (notify-author.ts's reason): the REPORTER is not the actioned party. Plan
 * B's appeals (spec §6) are for the user whose content was actioned, never
 * for whoever reported it — there is nothing for a reporter to appeal.
 */
import { postmarkSend } from "../auth/postmark";
import { escapeHtml } from "../auth/email-verify";
import type { DecisionKind } from "./decide";

export interface DsaOutcome {
  readonly decision: DecisionKind;
  /** The statement of reasons (DSA). Shown to the reporter. */
  readonly reason: string;
  readonly subject: "post" | "comment";
  /** The post's title — for a comment, its parent post's title. */
  readonly postTitle: string;
}

/**
 * Every decision outcome gets a reporter notice — unlike `sendModerationNotice`,
 * there is no "dismissal sends nothing" case here: a CONFIRMED notice is only
 * ever passed to this function once a ruling has resolved it, and the
 * reporter is owed an answer for every one of the three outcomes, including a
 * restore (which answers "no action was taken").
 */
const LEAD: Readonly<Record<DecisionKind, string>> = {
  remove: "We reviewed the content you reported and removed it.",
  keep_hidden: "We reviewed the content you reported and it will stay hidden.",
  restore:
    "We reviewed the content you reported and decided it does not break our rules or the law, so no action was taken.",
};

export async function sendDsaOutcome(
  env: Env,
  to: string,
  outcome: DsaOutcome,
): Promise<boolean> {
  const lead = LEAD[outcome.decision];
  const contentLine =
    outcome.subject === "post"
      ? `This is about the post you reported, "${outcome.postTitle}".`
      : `This is about the comment you reported, on "${outcome.postTitle}".`;
  const transparencyLine =
    "This decision was made by a human moderator, in keeping with the Digital Services Act.";

  return await postmarkSend(env, {
    from: "noreply@thinkersjournal.com",
    to,
    subject: "The content you reported has been reviewed",
    textBody: `${lead}\n\n${contentLine}\n\nReason given by the moderator:\n\n${outcome.reason}\n\n${transparencyLine}\n`,
    htmlBody: `<p>${escapeHtml(lead)}</p><p>${escapeHtml(contentLine)}</p><p><strong>Reason given by the moderator:</strong></p><p>${escapeHtml(outcome.reason)}</p><p>${escapeHtml(transparencyLine)}</p>`,
    stream: "outbound",
  });
}
