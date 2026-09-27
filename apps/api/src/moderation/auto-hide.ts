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
 */
import type { Client } from "pg";

import { loadPostTagSlugs, type PurgeTarget } from "./purge-target";

export const AUTO_HIDE_REPORTER_THRESHOLD = 3;

export type ReportTarget = { postId: string } | { commentId: string };

export async function maybeAutoHide(c: Client, target: ReportTarget): Promise<PurgeTarget | null> {
  const isPost = "postId" in target;
  const column = isPost ? "post_id" : "comment_id";
  const table = isPost ? "posts" : "comments";
  const id = isPost ? target.postId : target.commentId;

  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM reports
      WHERE ${column} = $1 AND created_at > now() - interval '24 hours'
        AND created_at >= COALESCE(
              (SELECT max(ma.created_at) FROM moderation_actions ma
                WHERE ma.${column} = $1 AND ma.action LIKE 'content\\_%'),
              '-infinity')`,
    [id],
  );
  const distinctReporters = Number(rows[0]?.n ?? "0");
  if (distinctReporters < AUTO_HIDE_REPORTER_THRESHOLD) return null;

  if (isPost) {
    const { rows: postRows } = await c.query<{ id: string; author_id: string }>(
      `UPDATE posts SET hidden_at = now() WHERE id = $1 AND hidden_at IS NULL RETURNING id, author_id`,
      [id],
    );
    const row = postRows[0];
    if (row === undefined) return null; // already hidden
    const tagSlugs = await loadPostTagSlugs(c, row.id);
    return { kind: "post", postId: row.id, authorId: row.author_id, tagSlugs };
  } else {
    const { rows: commentRows } = await c.query<{ id: string; post_id: string }>(
      `UPDATE comments SET hidden_at = now() WHERE id = $1 AND hidden_at IS NULL RETURNING id, post_id`,
      [id],
    );
    const row = commentRows[0];
    if (row === undefined) return null; // already hidden
    return { kind: "comment", postId: row.post_id };
  }
}
