/**
 * The admin "undelivered notices" list and RESEND (notice outbox design,
 * section 5, "A decision that is never delivered"; PR 3).
 *
 * A notice that reached `undeliverable` (the 7-day retry horizon, or a permanent
 * recipient refusal) leaves the decision in force and makes delivery a human
 * matter. This module is the human's two tools: see which notices never got out,
 * and send one again.
 *
 * ⚠️ RESEND RETURNS THE ROW TO `pending` WITH FRESH TOKENS. The stored body still
 * holds the ORIGINAL links (a row keeps them raw until delivery), and those
 * tokens may have expired while the notice sat undeliverable. Resend mints a new
 * appeal token (and a new delete-request token when the body had one) and swaps
 * them into `body_text` and `body_html`, so the user gets a working link. The old
 * tokens stay valid until their own expiry; they are for the same user and
 * action, so that grants nothing new.
 *
 * ⚠️ A REPORTER ROW CANNOT BE RESENT: its address was nulled when the row
 * settled (a reporter has no account to re-read it from), so the list shows it
 * as not resendable. An anonymised or vanished recipient is not resendable
 * either (nobody can receive it).
 *
 * ⚠️ NOTHING HERE LOGS A BODY, TITLE, REASON OR ADDRESS. The list carries the
 * subject line and the account handle, never the body.
 */
import type { Client } from "pg";

import { APPEAL_WINDOW_DAYS, type AdminUndeliveredNotice } from "@thinkersjournal/shared";

import { BEGIN_BOUNDED_TX } from "../db/client";
import { mintActionToken } from "./action-tokens";

const DAY_MS = 24 * 3600_000;
/** Bounded read, like the other admin lists. Resending one makes room for the next. */
export const UNDELIVERED_PAGE_SIZE = 200;

// The same two shapes `stripLiveLinks` (notice-outbox.ts) removes after delivery.
const APPEAL_LINK_RE = /[^\s"'<>]*\/appeal\?token=[A-Za-z0-9_%~-]*/g;
const DELETE_LINK_RE = /[^\s"'<>]*\/account\/delete-request\?token=[A-Za-z0-9_%~-]*/g;

export async function listUndeliveredNotices(c: Client): Promise<AdminUndeliveredNotice[]> {
  const { rows } = await c.query<{
    id: string;
    kind: AdminUndeliveredNotice["kind"];
    action_id: string;
    subject: string;
    created_at: Date;
    attempts: number;
    last_error: string | null;
    retain_until: Date;
    handle: string | null;
    resendable: boolean;
  }>(
    `SELECT o.id, o.kind, o.action_id, o.subject, o.created_at, o.attempts, o.last_error, o.retain_until,
            p.username AS handle,
            (o.recipient_user_id IS NOT NULL AND u.id IS NOT NULL AND u.anonymised_at IS NULL) AS resendable
       FROM moderation_notice_outbox o
       LEFT JOIN users u ON u.id = o.recipient_user_id
       LEFT JOIN profiles p ON p.user_id = o.recipient_user_id
      WHERE o.state = 'undeliverable'
      ORDER BY o.created_at DESC, o.id
      LIMIT $1`,
    [UNDELIVERED_PAGE_SIZE],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    actionId: r.action_id,
    subject: r.subject,
    createdAt: r.created_at.toISOString(),
    attempts: r.attempts,
    lastError: r.last_error,
    retainUntil: r.retain_until.toISOString(),
    recipientHandle: r.handle,
    resendable: r.resendable,
  }));
}

export type ResendOutcome =
  | { readonly kind: "resent" }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_resendable" };

/** Swap every link of one shape in `body` for `url`. A body without that shape is returned unchanged. */
function swapLinks(body: string, re: RegExp, url: string | null): string {
  return url === null ? body : body.replace(re, url);
}

/**
 * Return one `undeliverable` row to `pending`, with fresh tokens, in ONE
 * transaction. `origin` is the verification-link origin of the request.
 */
export async function resendNotice(c: Client, id: string, origin: string): Promise<ResendOutcome> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const { rows } = await c.query<{
      action_id: string;
      recipient_user_id: string | null;
      body_text: string;
      body_html: string;
    }>(
      `SELECT action_id, recipient_user_id, body_text, body_html
         FROM moderation_notice_outbox WHERE id = $1 AND state = 'undeliverable' FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return await finish(c, { kind: "not_found" });
    if (row.recipient_user_id === null) return await finish(c, { kind: "not_resendable" });
    // A body with no link (a termination notice) mints nothing below, so the
    // recipient must be checked directly: never queue mail to a scrubbed account.
    const live = await c.query(`SELECT 1 FROM users WHERE id = $1 AND anonymised_at IS NULL`, [row.recipient_user_id]);
    if ((live.rowCount ?? 0) === 0) return await finish(c, { kind: "not_resendable" });

    let bodyText = row.body_text;
    let bodyHtml = row.body_html;
    const ttlMs = APPEAL_WINDOW_DAYS * DAY_MS;
    for (const [re, purpose, path] of [
      [APPEAL_LINK_RE, "appeal", "/appeal"],
      [DELETE_LINK_RE, "delete_request", "/account/delete-request"],
    ] as const) {
      if (bodyText.search(re) === -1) continue;
      const token = await mintActionToken(c, { actionId: row.action_id, userId: row.recipient_user_id, purpose, ttlMs });
      // An anonymised or vanished account mints nothing: there is no one to send it to.
      if (token === null) return await finish(c, { kind: "not_resendable" });
      const url = `${origin}${path}?token=${encodeURIComponent(token)}`;
      bodyText = swapLinks(bodyText, re, url);
      bodyHtml = swapLinks(bodyHtml, re, url);
    }

    await c.query(
      `UPDATE moderation_notice_outbox
          SET state = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL,
              body_text = $2, body_html = $3, leased_until = NULL, leased_by = NULL
        WHERE id = $1 AND state = 'undeliverable'`,
      [id, bodyText, bodyHtml],
    );
    await c.query("COMMIT");
    return { kind: "resent" };
  } catch (err) {
    try {
      await c.query("ROLLBACK");
    } catch {
      // keep the root error
    }
    throw err;
  }
}

/** End the transaction without writing (a refusal), returning the outcome. */
async function finish<T>(c: Client, value: T): Promise<T> {
  try {
    await c.query("ROLLBACK");
  } catch {
    // nothing to keep
  }
  return value;
}
