/**
 * Tell a user an action was taken on their ACCOUNT (spec §5, §7).
 *
 * Same transport and the same reasons as notify-author.ts: direct
 * transactional email on the "outbound" stream, bypassing notification
 * preferences, because a user cannot opt out of being told they were actioned.
 * NEVER THROWS.
 *
 * `terminate` has its OWN entry point, `sendTerminationNotice`, and
 * deliberately NOT a kind of `AccountNotice`: that type carries a reason and
 * appeal/delete links, and a termination carries none of them (#114 ruling).
 * The text names no report, evidence or reason. No route calls it yet.
 */
import { postmarkSend } from "../auth/postmark";
import { escapeHtml } from "../auth/email-verify";

import { APPEAL_WINDOW_DAYS, DISPUTE_EMAIL, GUIDELINES_VERSION, REDRESS_SENTENCE } from "@thinkersjournal/shared";
import { guidelinesLine, type RenderedNotice } from "./notify-author";

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

async function deliver(
  env: Env,
  to: string,
  rendered: RenderedNotice,
  onSent?: (rendered: RenderedNotice) => Promise<void>,
): Promise<boolean> {
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

/** #114 ruling: the ONE generic redress line of a termination notice. */
export const TERMINATION_REDRESS_SENTENCE = `You may contest this by contacting ${DISPUTE_EMAIL}. You keep the right to take this to an out-of-court dispute body or a court.`;

const TERMINATION_LEAD = "Your account has been terminated for violating community guidelines.";

/**
 * #114: the termination notice. Takes NO reason, evidence, title, hash or link:
 * there is nothing to leak because nothing is accepted. Never mentions a report
 * to anyone.
 */
export function renderTerminationNotice(): RenderedNotice {
  return {
    subject: "Your account has been terminated",
    textBody: `${TERMINATION_LEAD}

${TERMINATION_REDRESS_SENTENCE}`,
    htmlBody: `<p>${escapeHtml(TERMINATION_LEAD)}</p><p>${escapeHtml(TERMINATION_REDRESS_SENTENCE)}</p>`,
  };
}

/** NEVER THROWS. @param onSent same contract as sendAccountActionNotice. */
export async function sendTerminationNotice(
  env: Env,
  to: string,
  onSent?: (rendered: RenderedNotice) => Promise<void>,
): Promise<boolean> {
  try {
    return await deliver(env, to, renderTerminationNotice(), onSent);
  } catch (err) {
    console.error("termination notice threw", err);
    return false;
  }
}

/**
 * Render the notice for a warn / suspend / ban. Pure: the notice outbox
 * (notice-enqueue.ts) renders it inside the action's transaction and
 * `sendAccountActionNotice` renders it for a direct send.
 */
export function renderAccountActionNotice(notice: AccountNotice): RenderedNotice {
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
  // Every lead above names the Community Guidelines, so every kind links to them.
  const guidelines = guidelinesLine();
  const guidelinesHtml = `<p>You can read our Community Guidelines (version ${escapeHtml(GUIDELINES_VERSION)}): <a href="${escapeHtml(guidelines.url)}">${escapeHtml(guidelines.url)}</a></p>`;

  return {
    subject: SUBJECT[notice.kind],
    textBody: `${text}

Reason given by the moderator:

${notice.reason}

${guidelines.text}

${REDRESS_SENTENCE}
${appealTextLine}${deleteRequestTextLine}`,
    htmlBody: `<p>${escapeHtml(text)}</p><p><strong>Reason given by the moderator:</strong></p><p>${escapeHtml(notice.reason)}</p>${guidelinesHtml}<p>${escapeHtml(REDRESS_SENTENCE)}</p>${appealHtmlLine}${deleteRequestHtmlLine}`,
  };
}

/** @param onSent #57 Q9 — the exact strings sent, only on acceptance; best-effort (see sendModerationNotice). */
export async function sendAccountActionNotice(
  env: Env,
  to: string,
  notice: AccountNotice,
  onSent?: (rendered: RenderedNotice) => Promise<void>,
): Promise<boolean> {
  try {
    return await deliver(env, to, renderAccountActionNotice(notice), onSent);
  } catch (err) {
    console.error("account notice threw", err);
    return false;
  }
}
