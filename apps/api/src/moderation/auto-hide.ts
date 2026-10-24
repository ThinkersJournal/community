// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * AUTO-HIDE — when a single post/comment draws >= AUTO_HIDE_REPORTER_THRESHOLD
 * distinct reporters within the last 24h, it is hidden pending review (design
 * doc docs/superpowers/specs/2026-09-02-m4-report-block-design.md §6, decision
 * #14). Global (not per-viewer): `hidden_at` is a plain column on `posts` /
 * `comments`, filtered out of every public read.
 *
 * ⚠️ `count(*)` IS THE DISTINCT-REPORTER COUNT, not an approximation of it. The
 * migration 0012 `reports_reporter_post_unique` / `reports_reporter_comment_unique`
 * constraints make one (reporter, target) pair at most one row, so every row
 * already IS one distinct reporter — no `COUNT(DISTINCT reporter_id)` needed.
 *
 * Idempotent by construction: the `UPDATE ... WHERE hidden_at IS NULL` guard
 * means a report arriving after the target is already hidden touches zero
 * rows — it never re-stamps `hidden_at` (so the original hide time is
 * preserved) and it never un-hides (there is no path that clears the column
 * here at all).
 *
 * ⚠️ ONLY REPORTS NO MODERATOR HAS RULED ON COUNT (issue #55). A report is
 * counted only if it is at least as new as the target's latest `content_*`
 * action. Counting every report in the window let one new report re-hide a
 * post a human had just Restored — the reports behind the first hide were
 * still in the count — so automation overrode a human decision. The cut-off
 * matches `queue.ts`'s definition of "handled": a report stamped in the same
 * instant as a ruling is treated as unruled there, so it is here too.
 * The latest-action lookup is covered by the partial indexes
 * `moderation_actions_post_idx` / `moderation_actions_comment_idx`.
 *
 * ⚠️ "RULED" MEANS A HUMAN RULING (#57). A hide writes a `content_auto_hide`
 * row (actor "system"); that row is an audit fact, not a ruling, so the
 * cut-off filters to HUMAN_CONTENT_RULING_KINDS. Counting it would put the
 * cut-off at the hide itself and make every later report start from zero.
 *
 * The hide and its audit row commit together in one transaction OWNED HERE
 * (the report route runs in autocommit and passes a bare client), and the row
 * is written only when the UPDATE actually hid something, so a second report
 * on already-hidden content appends nothing.
 */
import type { Client } from "pg";

import { BEGIN_BOUNDED_TX } from "../db/client";
import { recordModerationAction } from "./actions";
import { loadPostTagSlugs, type PurgeTarget } from "./purge-target";
import { HUMAN_CONTENT_RULING_KINDS_SQL } from "./visibility-actions";

export const AUTO_HIDE_REPORTER_THRESHOLD = 3;

/**
 * The fixed reason on the `content_auto_hide` row (#57, Q4=B). A constant, never
 * built from the reports: no reporter identity, count or threshold may reach the
 * log's `reason`, which is the column a statement of reasons is read from. The
 * author notice copy is fixed for the same reason (notify-author.ts).
 */
export const AUTO_HIDE_ACTION_REASON = "Hidden automatically pending moderator review.";

export type ReportTarget = { postId: string } | { commentId: string };

/**
 * What an auto-hide did, for the cache purge AND the author's notice (#56).
 * `null` from `maybeAutoHide` still means NOTHING was hidden: that is what
 * makes the notice fire exactly once per hide event, and never on a later
 * report against content that is already hidden.
 *
 * ⚠️ It carries the content's id, never the author's id or address: the
 * notice reads the recipient AT SEND TIME (notify-author.ts), so content
 * deleted, restored or an account anonymised in the meantime is not mailed.
 */
export interface AutoHideResult {
  readonly purge: PurgeTarget;
  readonly subject: "post" | "comment";
  readonly subjectId: string;
}

export async function maybeAutoHide(c: Client, target: ReportTarget): Promise<AutoHideResult | null> {
  const isPost = "postId" in target;
  const column = isPost ? "post_id" : "comment_id";
  const table = isPost ? "posts" : "comments";
  const id = isPost ? target.postId : target.commentId;

  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM reports
      WHERE ${column} = $1 AND created_at > now() - interval '24 hours'
        AND created_at >= COALESCE(
              (SELECT max(ma.created_at) FROM moderation_actions ma
                WHERE ma.${column} = $1 AND ma.action IN (${HUMAN_CONTENT_RULING_KINDS_SQL})),
              '-infinity')`,
    [id],
  );
  const distinctReporters = Number(rows[0]?.n ?? "0");
  if (distinctReporters < AUTO_HIDE_REPORTER_THRESHOLD) return null;

  await c.query(BEGIN_BOUNDED_TX);
  try {
    const hidden = await hideAndRecord(c, isPost, id);
    // Nothing hidden (already hidden, or gone): no row to keep.
    await c.query(hidden === null ? "ROLLBACK" : "COMMIT");
    return hidden;
  } catch (err) {
    // The ROLLBACK gets its own try/catch so a dead connection cannot replace
    // the root error (same shape as decide.ts's applyDecision).
    try {
      await c.query("ROLLBACK");
    } catch {
      // Swallowed deliberately: the original error below is the useful one.
    }
    throw err;
  }
}

async function hideAndRecord(c: Client, isPost: boolean, id: string): Promise<AutoHideResult | null> {
  // The author's id and address ride the same UPDATE, exactly as decide.ts
  // fills `subject_user_id` / `subject_label` for a human decision.
  if (isPost) {
    const { rows: postRows } = await c.query<{ id: string; author_id: string; email: string }>(
      `UPDATE posts AS t SET hidden_at = now()
         FROM users u
        WHERE t.id = $1 AND t.hidden_at IS NULL AND u.id = t.author_id
        RETURNING t.id, t.author_id, u.email`,
      [id],
    );
    const row = postRows[0];
    if (row === undefined) return null; // already hidden
    await recordModerationAction(c, {
      actorAdmin: "system",
      action: "content_auto_hide",
      reason: AUTO_HIDE_ACTION_REASON,
      postId: row.id,
      subjectUserId: row.author_id,
      subjectLabel: row.email,
    });
    const tagSlugs = await loadPostTagSlugs(c, row.id);
    return {
      purge: { kind: "post", postId: row.id, authorId: row.author_id, tagSlugs },
      subject: "post",
      subjectId: row.id,
    };
  }
  const { rows: commentRows } = await c.query<{ id: string; post_id: string; author_id: string; email: string }>(
    `UPDATE comments AS t SET hidden_at = now()
       FROM users u
      WHERE t.id = $1 AND t.hidden_at IS NULL AND u.id = t.author_id
      RETURNING t.id, t.post_id, t.author_id, u.email`,
    [id],
  );
  const row = commentRows[0];
  if (row === undefined) return null; // already hidden
  await recordModerationAction(c, {
    actorAdmin: "system",
    action: "content_auto_hide",
    reason: AUTO_HIDE_ACTION_REASON,
    commentId: row.id,
    subjectUserId: row.author_id,
    subjectLabel: row.email,
  });
  return {
    purge: { kind: "comment", postId: row.post_id },
    subject: "comment",
    subjectId: row.id,
  };
}
