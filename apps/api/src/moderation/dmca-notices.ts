// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * DMCA takedown notices, intake half (ROADMAP R9; design note
 * docs/superpowers/specs/2026-10-25-dmca-flow-design.md). The shape deliberately
 * mirrors `dsa-notices.ts` (insert only if the target is publicly visible, a
 * hashed confirmation token, a reaper for the unconfirmed), because the reasoning
 * there carries over unchanged.
 *
 * ⚠️ AC-1: NOTHING here touches `reports`, `hidden_at` or `maybeAutoHide`. A
 * notice is queue input for a human only: even a confirmed, complete notice
 * hides nothing until a moderator decides it.
 */
import type { Client } from "pg";

import { DMCA_CONFIRM_WINDOW_DAYS } from "@thinkersjournal/shared";

import { base64urlEncode, sha256Hex } from "../auth/encoding";
import { withClient } from "../db/client";

import type { DmcaNoticeInputT } from "@thinkersjournal/shared";

/**
 * The fixed KV key under which the most recently issued RAW confirmation token
 * is stashed when `TEST_ROUTES=1`, the same test seam as
 * `TEST_LAST_DSA_TOKEN_KEY` (moderation/dsa-notices.ts). Written only by
 * routes/dmca-notice.ts's `handleDmcaNotice`.
 */
export const TEST_LAST_DMCA_TOKEN_KEY = "__test:last-dmca-token";

/** The fields stored on a notice, apart from the target (which the caller resolves). */
type DmcaNoticeFields = Omit<DmcaNoticeInputT, "turnstileToken" | "statementGoodFaith" | "statementAccuracy" | "contentUrl">;

/**
 * Insert a notice ONLY if its target is publicly visible; `null` = not (the
 * caller answers the one 404). `target_kind` and `target_label` are filled in the
 * SAME `INSERT ... SELECT` as the visibility check, so "is it public" and "write
 * the row" are one statement with no check-then-act gap (see createDsaNotice).
 */
export async function createDmcaNotice(
  c: Client,
  input: DmcaNoticeFields,
): Promise<{ id: string; token: string } | null> {
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(token);
  const common = [
    input.complainantEmail, input.complainantName, input.complainantAddress, input.complainantPhone,
    input.signature, input.workDescription, hash,
  ];
  const { rows } =
    input.postId !== undefined
      ? await c.query<{ id: string }>(
          `INSERT INTO dmca_notices (complainant_email, complainant_name, complainant_address, complainant_phone,
                                     signature, work_description, statement_good_faith, statement_accuracy,
                                     verify_token_hash, target_kind, target_label, post_id)
           SELECT $1, $2, $3, $4, $5, $6, true, true, $7, 'post', p.title, p.id FROM posts p
            WHERE p.id = $8 AND p.status = 'published' AND p.hidden_at IS NULL
           RETURNING id`,
          [...common, input.postId],
        )
      : await c.query<{ id: string }>(
          `INSERT INTO dmca_notices (complainant_email, complainant_name, complainant_address, complainant_phone,
                                     signature, work_description, statement_good_faith, statement_accuracy,
                                     verify_token_hash, target_kind, target_label, comment_id)
           SELECT $1, $2, $3, $4, $5, $6, true, true, $7, 'comment', left(cm.body_markdown, 120), cm.id
             FROM comments cm JOIN posts p ON p.id = cm.post_id
            WHERE cm.id = $8 AND cm.hidden_at IS NULL AND cm.deleted_at IS NULL
              AND p.status = 'published' AND p.hidden_at IS NULL
           RETURNING id`,
          [...common, input.commentId],
        );
  const row = rows[0];
  return row === undefined ? null : { id: row.id, token };
}

/** A hash inside the window is a valid PEEK whether or not already confirmed (as peekDsaToken). */
export async function peekDmcaToken(c: Client, token: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM dmca_notices
      WHERE verify_token_hash = $1
        AND created_at > now() - make_interval(days => $2::int)`,
    [await sha256Hex(token), DMCA_CONFIRM_WINDOW_DAYS],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Confirms ONLY, and idempotently (`COALESCE` keeps the first stamp), exactly as
 * `confirmDsaNotice`. Decides, counts and hides nothing.
 */
export async function confirmDmcaNotice(c: Client, token: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE dmca_notices SET email_verified_at = COALESCE(email_verified_at, now())
      WHERE verify_token_hash = $1
        AND created_at > now() - make_interval(days => $2::int)`,
    [await sha256Hex(token), DMCA_CONFIRM_WINDOW_DAYS],
  );
  return (rowCount ?? 0) > 0;
}

/** Caps one run's DELETE so a backlog cannot make the cron an unbounded statement. */
const DMCA_REAP_BATCH = 500;

/**
 * Hard-delete unconfirmed notices older than the window. `email_verified_at IS
 * NULL` is the whole guard: a confirmed notice is a legal record and is never
 * reaped here. Run by the daily tick in src/index.ts. Returns the count.
 */
export async function reapUnconfirmedDmcaNotices(env: Env, ctx: ExecutionContext): Promise<number> {
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rowCount } = await c.query(
      `DELETE FROM dmca_notices WHERE id IN (
         SELECT id FROM dmca_notices
          WHERE email_verified_at IS NULL
            AND created_at < now() - make_interval(days => $1::int)
          ORDER BY created_at
          LIMIT $2
       )`,
      [DMCA_CONFIRM_WINDOW_DAYS, DMCA_REAP_BATCH],
    );
    return rowCount ?? 0;
  });
  if (n > 0) {
    console.log(`reap-unconfirmed-dmca-notices: deleted ${n} notice(s)`);
  }
  return n;
}
