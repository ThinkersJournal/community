/**
 * The appeal-outcome notice: what the appellant is told when a moderator
 * grants or denies their appeal (#113 plan B). Moved out of
 * routes/admin-appeals.ts so the notice outbox can render it inside the
 * resolution's transaction (notice outbox design, section 2, kind 4).
 *
 * ⚠️ NO APPEAL LINK: an appeal's outcome is final here, and a link would
 * invite a second appeal of the same decision.
 */
import { escapeHtml } from "../auth/email-verify";
import type { RenderedNotice } from "./notify-author";

export interface AppealOutcomeNotice {
  readonly outcome: "granted" | "denied";
  /** The moderator's reason, trimmed. */
  readonly reason: string;
}

export function renderAppealOutcomeNotice(notice: AppealOutcomeNotice): RenderedNotice {
  const granted = notice.outcome === "granted";
  const lead = granted ? "Your appeal was granted." : "Your appeal was not granted.";
  return {
    subject: granted ? "Your appeal was granted" : "Your appeal was not granted",
    textBody: `${lead}\n\nReason given by the moderator:\n\n${notice.reason}\n`,
    htmlBody: `<p>${escapeHtml(lead)}</p><p><strong>Reason given by the moderator:</strong></p><p>${escapeHtml(notice.reason)}</p>`,
  };
}
