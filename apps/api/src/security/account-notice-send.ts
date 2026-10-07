/**
 * Sends one account-holder notice (security-alerting spec §4.2, §4.4). Used by
 * the routes (an immediate notice) and by `UserSecurityDO`'s alarm (a deferred
 * one), so both build the same text from the same inputs. The link always comes
 * from `CANONICAL_ORIGIN`, never from a request (G2).
 *
 * ⚠️ NEVER LOGS the address, the user id or the body (postmark.ts's own rule).
 */
import {
  classifyPostmark,
  newSignInNotice,
  passwordResetNotice,
  type AccountNoticeKind,
  type NoticeText,
} from "@thinkersjournal/shared";

import { CANONICAL_ORIGIN, escapeHtml } from "../auth/email-verify";
import { postmarkSendOutcome } from "../auth/postmark";
import { withClient } from "../db/client";

/** The `forgot-password` link every notice carries (§4.3). */
export const FORGOT_PASSWORD_URL = `${CANONICAL_ORIGIN}/forgot-password`;

/** What happened to one send attempt. */
export type NoticeSendResult = "sent" | "permanent" | "transient" | "gone";

/** Everything a notice needs, with no request in hand (G2). */
export interface NoticeFacts {
  readonly kind: AccountNoticeKind;
  readonly atMs: number;
  readonly country: string | null;
  /** Earlier events folded in: count and the first one's time. Null for none. */
  readonly coalesced: { readonly count: number; readonly sinceMs: number } | null;
  readonly listWasEmpty: boolean;
}

export function noticeText(f: NoticeFacts): NoticeText {
  const input = {
    at: new Date(f.atMs),
    country: f.country,
    coalesced: f.coalesced === null ? null : { count: f.coalesced.count, since: new Date(f.coalesced.sinceMs) },
    forgotPasswordUrl: FORGOT_PASSWORD_URL,
  };
  return f.kind === "new_sign_in" ? newSignInNotice({ ...input, listWasEmpty: f.listWasEmpty }) : passwordResetNotice(input);
}

/** The text as HTML: escaped, with the link as an anchor (§4.2, like `sendPasswordResetEmail`). */
export function noticeHtml(text: NoticeText): string {
  const escaped = escapeHtml(text.textBody);
  const linked = escaped.replace(escapeHtml(FORGOT_PASSWORD_URL), `<a href="${escapeHtml(FORGOT_PASSWORD_URL)}">${escapeHtml(FORGOT_PASSWORD_URL)}</a>`);
  return linked
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** The live address, or null when the account no longer exists (§4.5: anonymised, reaped). */
async function liveAddress(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, userId: string): Promise<string | null> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ email: string }>(
      "SELECT email FROM users WHERE id = $1 AND anonymised_at IS NULL",
      [userId],
    );
    return rows.at(0)?.email ?? null;
  });
}

export async function sendNotice(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  userId: string,
  facts: NoticeFacts,
): Promise<NoticeSendResult> {
  const to = await liveAddress(env, ctx, userId);
  if (to === null) return "gone";
  const text = noticeText(facts);
  const outcome = await postmarkSendOutcome(env, {
    from: "noreply@thinkersjournal.com",
    to,
    subject: text.subject,
    textBody: text.textBody,
    htmlBody: noticeHtml(text),
    stream: "outbound",
  });
  return classifyPostmark(outcome);
}
