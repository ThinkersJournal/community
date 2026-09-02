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
 */
import type { Client } from "pg";

export const AUTO_HIDE_REPORTER_THRESHOLD = 3;

export type ReportTarget = { postId: string } | { commentId: string };

export async function maybeAutoHide(c: Client, target: ReportTarget): Promise<void> {
  const isPost = "postId" in target;
  const column = isPost ? "post_id" : "comment_id";
  const table = isPost ? "posts" : "comments";
  const id = isPost ? target.postId : target.commentId;

  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM reports
      WHERE ${column} = $1 AND created_at > now() - interval '24 hours'`,
    [id],
  );
  const distinctReporters = Number(rows[0]?.n ?? "0");
  if (distinctReporters < AUTO_HIDE_REPORTER_THRESHOLD) return;

  await c.query(`UPDATE ${table} SET hidden_at = now() WHERE id = $1 AND hidden_at IS NULL`, [id]);
}
