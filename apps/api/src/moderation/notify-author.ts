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

interface Copy {
  readonly subject: string;
  readonly lead: string;
}

const COPY: Readonly<Record<DecisionKind, Copy>> = {
  restore: {
    subject: "Your content has been restored",
    lead: "We reviewed a report about your content and restored it. It is visible again.",
  },
  keep_hidden: {
    subject: "Your content remains hidden after review",
    lead: "We reviewed your content and it remains hidden because it does not meet our Community Guidelines.",
  },
  remove: {
    subject: "Your content has been removed",
    lead: "We reviewed your content and removed it because it does not meet our Community Guidelines.",
  },
};

// ⚠️ NO APPEAL LINK YET. A DSA statement of reasons must tell the user how to
// challenge the decision, but the in-app appeal form (spec §6) is not built and
// /appeal does not exist — a dead link is worse than none. Tracked as issue #53,
// which must close before real moderators are given Cloudflare Access.

export async function sendModerationNotice(
  env: Env,
  to: string,
  decision: DecisionKind,
  reason: string,
): Promise<void> {
  const { subject, lead } = COPY[decision];

  await postmarkSend(env, {
    from: "noreply@thinkersjournal.com",
    to,
    subject,
    textBody: `${lead}\n\nReason given by the reviewer:\n\n${reason}\n`,
    htmlBody:
      `<p>${escapeHtml(lead)}</p><p><strong>Reason given by the reviewer:</strong></p><p>${escapeHtml(reason)}</p>`,
    stream: "outbound",
  });
}
