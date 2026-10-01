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
 * ⚠️ NO APPEAL LINK YET — plan B adds the per-purpose appeal token. A dead
 * link is worse than none (same reasoning as notify-author.ts).
 */
import { postmarkSend } from "../auth/postmark";
import { escapeHtml } from "../auth/email-verify";

export interface AccountNotice {
  readonly kind: "warn" | "suspend" | "ban";
  readonly reason: string;
  /** Required for `suspend`. */
  readonly suspendedUntil?: Date;
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

export async function sendAccountActionNotice(env: Env, to: string, notice: AccountNotice): Promise<boolean> {
  try {
    const text = lead(notice);
    return await postmarkSend(env, {
      from: "noreply@thinkersjournal.com",
      to,
      subject: SUBJECT[notice.kind],
      textBody: `${text}\n\nReason given by the moderator:\n\n${notice.reason}\n`,
      htmlBody: `<p>${escapeHtml(text)}</p><p><strong>Reason given by the moderator:</strong></p><p>${escapeHtml(notice.reason)}</p>`,
      stream: "outbound",
    });
  } catch (err) {
    console.error("account notice threw", err);
    return false;
  }
}
