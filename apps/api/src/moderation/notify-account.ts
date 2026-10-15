/**
 * Tell a user an action was taken on their ACCOUNT (spec §5, §7).
 *
 * Same transport and the same reasons as notify-author.ts: direct
 * transactional email on the "outbound" stream, bypassing notification
 * preferences, because a user cannot opt out of being told they were actioned.
 * NEVER THROWS.
 *
 * ⚠️ NO `terminate` NOTICE. Whether a CSAM-terminated user may be told why is
 * an open legal question (#114), so the type does not admit it.
 */
import { postmarkSend } from "../auth/postmark";
import { escapeHtml } from "../auth/email-verify";

import { APPEAL_WINDOW_DAYS, REDRESS_SENTENCE } from "@thinkersjournal/shared";
import type { RenderedNotice } from "./notify-author";

/** #50 Q4 — what a barred account's deletion request does. Also used verbatim by routes/delete-request.ts's resend email. */
export const DELETE_REQUEST_SENTENCE_AFTER =
  "While the account is restricted, the request is recorded, and the account is anonymised (your posts stay, credited to a deleted user) after 30 days unless it is under a legal hold, as our privacy policy describes.";

export interface AccountNotice {
  readonly kind: "warn" | "suspend" | "ban";
  readonly reason: string;
  /** Required for `suspend`. */
  readonly suspendedUntil?: Date;
  /** #113 plan B. Omitted when the mint failed or the account was anonymised. */
  readonly appealUrl?: string;
  /** #113 plan B. Only rendered when `kind !== "warn"`. */
  readonly deleteRequestUrl?: string;
}

const SUBJECT: Readonly<Record<AccountNotice["kind"], string>> = {
  warn: "A warning about your account",
  suspend: "Your account has been suspended",
  ban: "Your account has been banned",
};

function lead(notice: AccountNotice): string {
  switch (notice.kind) {
    case "warn":
      return "A moderator has issued a warning on your account for breaking our Community Guidelines. Your account is not restricted.";
    case "suspend":
      return `Your account has been suspended for breaking our Community Guidelines. You will not be able to sign in until ${notice.suspendedUntil?.toUTCString() ?? "the suspension ends"}.`;
    case "ban":
      return "Your account has been permanently banned for breaking our Community Guidelines. You will not be able to sign in again.";
  }
}

/** @param onSent #57 Q9 — the exact strings sent, only on acceptance; best-effort (see sendModerationNotice). */
export async function sendAccountActionNotice(
  env: Env,
  to: string,
  notice: AccountNotice,
  onSent?: (rendered: RenderedNotice) => Promise<void>,
): Promise<boolean> {
  try {
    const text = lead(notice);

    const appealTextLine =
      notice.appealUrl === undefined ? "" : `\nYou can appeal this decision within ${APPEAL_WINDOW_DAYS} days: ${notice.appealUrl}`;
    const appealHtmlLine =
      notice.appealUrl === undefined
        ? ""
        : `<p>You can appeal this decision within ${APPEAL_WINDOW_DAYS} days: <a href="${escapeHtml(notice.appealUrl)}">${escapeHtml(notice.appealUrl)}</a></p>`;

    const deleteRequestTextLine =
      notice.deleteRequestUrl === undefined || notice.kind === "warn"
        ? ""
        : `\nYou can also ask for your account to be deleted: ${notice.deleteRequestUrl}\n${DELETE_REQUEST_SENTENCE_AFTER}`;
    const deleteRequestHtmlLine =
      notice.deleteRequestUrl === undefined || notice.kind === "warn"
        ? ""
        : `<p>You can also ask for your account to be deleted: <a href="${escapeHtml(notice.deleteRequestUrl)}">${escapeHtml(notice.deleteRequestUrl)}</a>. ${escapeHtml(DELETE_REQUEST_SENTENCE_AFTER)}</p>`;

    // #57 Q8=A: every kind here (warn/suspend/ban) is adverse. Positioned
    // before the appeal line so it appears when the appeal link is absent.
    const rendered: RenderedNotice = {
      subject: SUBJECT[notice.kind],
      textBody: `${text}

Reason given by the moderator:

${notice.reason}

${REDRESS_SENTENCE}
${appealTextLine}${deleteRequestTextLine}`,
      htmlBody: `<p>${escapeHtml(text)}</p><p><strong>Reason given by the moderator:</strong></p><p>${escapeHtml(notice.reason)}</p><p>${escapeHtml(REDRESS_SENTENCE)}</p>${appealHtmlLine}${deleteRequestHtmlLine}`,
    };
    const sent = await postmarkSend(env, { from: "noreply@thinkersjournal.com", to, ...rendered, stream: "outbound" });
    if (sent && onSent !== undefined) {
      try {
        await onSent(rendered);
      } catch {
        // Best-effort by contract; the caller logs with the action id.
      }
    }
    return sent;
  } catch (err) {
    console.error("account notice threw", err);
    return false;
  }
}
