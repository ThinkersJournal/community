/**
 * DSA notices (spec §3.3, §8). ⚠️ AC-1: NOTHING here touches `reports`,
 * `hidden_at` or `maybeAutoHide`. A notice is queue input for a human only.
 */
import type { Client } from "pg";

import { base64urlEncode, sha256Hex } from "../auth/encoding";
import { withClient } from "../db/client";

import type { DsaNoticeInputT } from "@thinkersjournal/shared";

/** Insert a notice ONLY if its target is publicly visible. `null` = not (the caller 404s). */
export async function createDsaNotice(
  c: Client,
  input: Omit<DsaNoticeInputT, "turnstileToken" | "goodFaith">,
): Promise<{ id: string; token: string } | null> {
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(token);
  // ⚠️ The visibility predicate is INSIDE the INSERT … SELECT, so "is it
  // public" and "write the row" are one statement — no check-then-act gap.
  const { rows } =
    input.postId !== undefined
      ? await c.query<{ id: string }>(
          `INSERT INTO dsa_notices (reporter_email, reporter_name, good_faith, verify_token_hash, post_id, reason, statement)
           SELECT $1, $2, true, $3, p.id, $5, $6 FROM posts p
            WHERE p.id = $4 AND p.status = 'published' AND p.hidden_at IS NULL
           RETURNING id`,
          [input.reporterEmail, input.reporterName, hash, input.postId, input.reason, input.statement],
        )
      : await c.query<{ id: string }>(
          `INSERT INTO dsa_notices (reporter_email, reporter_name, good_faith, verify_token_hash, comment_id, reason, statement)
           SELECT $1, $2, true, $3, cm.id, $5, $6 FROM comments cm JOIN posts p ON p.id = cm.post_id
            WHERE cm.id = $4 AND cm.hidden_at IS NULL AND cm.deleted_at IS NULL
              AND p.status = 'published' AND p.hidden_at IS NULL
           RETURNING id`,
          [input.reporterEmail, input.reporterName, hash, input.commentId, input.reason, input.statement],
        );
  const row = rows[0];
  return row === undefined ? null : { id: row.id, token };
}

/** Confirmation links stop working, and unconfirmed notices are reaped, after this. */
export const DSA_CONFIRM_WINDOW_DAYS = 7;

export async function peekDsaToken(c: Client, token: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM dsa_notices
      WHERE verify_token_hash = $1 AND email_verified_at IS NULL
        AND created_at > now() - make_interval(days => $2::int)`,
    [await sha256Hex(token), DSA_CONFIRM_WINDOW_DAYS],
  );
  return (rowCount ?? 0) > 0;
}

/** ⚠️ Confirms ONLY. AC-1: it does not count, report, or hide anything. */
export async function confirmDsaNotice(c: Client, token: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE dsa_notices SET email_verified_at = now()
      WHERE verify_token_hash = $1 AND email_verified_at IS NULL
        AND created_at > now() - make_interval(days => $2::int)`,
    [await sha256Hex(token), DSA_CONFIRM_WINDOW_DAYS],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Caps one run's DELETE so a pathological backlog cannot turn a routine cron
 * into an unbounded statement — same shape and same reasoning as
 * `auth/reap-unverified.ts`'s `REAP_BATCH`.
 */
const DSA_REAP_BATCH = 500;

/**
 * Hard-delete unconfirmed DSA notices older than `DSA_CONFIRM_WINDOW_DAYS`.
 * Run daily by src/index.ts's `scheduled` on cron `"30 3 * * *"`, next to
 * `reapUnverifiedAccounts`.
 *
 * ⚠️ `email_verified_at IS NULL` is the whole guard: a CONFIRMED notice is
 * never reaped, no matter its age — see Review Focus 5 / dsa-notice-confirm.test.ts.
 *
 * Returns the number of notices reaped, for the caller to log/observe.
 */
export async function reapUnconfirmedDsaNotices(
  env: Env,
  ctx: ExecutionContext,
): Promise<number> {
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rowCount } = await c.query(
      `DELETE FROM dsa_notices WHERE id IN (
         SELECT id FROM dsa_notices
          WHERE email_verified_at IS NULL
            AND created_at < now() - make_interval(days => $1::int)
          ORDER BY created_at
          LIMIT $2
       )`,
      [DSA_CONFIRM_WINDOW_DAYS, DSA_REAP_BATCH],
    );
    return rowCount ?? 0;
  });
  if (n > 0) {
    console.log(`reap-unconfirmed-dsa-notices: deleted ${n} notice(s)`);
  }
  return n;
}
