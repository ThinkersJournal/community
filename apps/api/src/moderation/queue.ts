/**
 * THE MODERATION REVIEW QUEUE — a derived query, never a table.
 *
 * ⚠️ A target is OPEN if it has at least one report and NO `content_*` action
 * recorded after its newest report. That definition lives here and nowhere
 * else: `moderation_actions` is the single source of truth for "handled".
 *
 * ⚠️ DO NOT ADD A `status` COLUMN. The spec forbids it by name. A status column
 * is a second copy of a fact the log already holds, and the two drift silently —
 * the queue would show the column while the log, the thing that must be true for
 * appeals and DSA statements of reasons, is the copy nobody reads. If this ever
 * gets too slow the answer is an index or a materialized view derived FROM the
 * log, never a hand-maintained duplicate of it.
 *
 * ⚠️ THIS QUERY DELIBERATELY READS HIDDEN ROWS. That is its purpose — the queue
 * exists to show a moderator what auto-hide took down. It therefore does NOT
 * carry `hidden_at IS NULL`, and it lives outside `src/routes/`, which is the
 * only tree `test/hidden-at-read-guard.node.test.ts` scans.
 *
 * The property that makes that safe is NOT its directory. It is:
 *   ⚠️ THIS FUNCTION IS REACHABLE ONLY THROUGH `requireAdmin` — a verified
 *   Cloudflare Access principal, never a member session, never anonymous.
 * `test/admin-queue-route.test.ts` re-checks that property rather than trusting
 * the file's location.
 *
 * Takes the caller's `pg.Client` and never opens its own connection, matching
 * `auto-hide.ts`, `is-blocked.ts` and `actions.ts`.
 */
import type { Client } from "pg";

export const QUEUE_PAGE_SIZE = 50;

export interface QueueItem {
  readonly kind: "post" | "comment";
  readonly targetId: string;
  /** Post title, or the first 120 characters of a comment. */
  readonly excerpt: string;
  /** Non-null when auto-hide (or a prior decision) has taken it down. */
  readonly hiddenAt: Date | null;
  readonly reportCount: number;
  /** 7 = sexual … 1 = other. Higher sorts first. */
  readonly severityRank: number;
  /** Age of the oldest unactioned report — surfaced so an item cannot rot unseen. */
  readonly oldestReportAt: Date;
}

interface QueueRow {
  kind: "post" | "comment";
  target_id: string;
  excerpt: string;
  hidden_at: Date | null;
  report_count: number;
  severity_rank: number;
  oldest_report_at: Date;
}

// Founder decision, fixed: sexual > violence > hate > harassment >
// ip_infringement > spam > other. Inline in SQL so ordering happens in the
// database rather than over a truncated page.
const SEVERITY_CASE = `CASE r.reason
        WHEN 'sexual' THEN 7 WHEN 'violence' THEN 6 WHEN 'hate' THEN 5
        WHEN 'harassment' THEN 4 WHEN 'ip_infringement' THEN 3
        WHEN 'spam' THEN 2 ELSE 1 END`;

const SELECT_OPEN_QUEUE = `
WITH post_reports AS (
  SELECT r.post_id AS target_id, count(*)::int AS report_count,
         min(r.created_at) AS oldest_report_at, max(r.created_at) AS newest_report_at,
         max(${SEVERITY_CASE}) AS severity_rank
    FROM reports r WHERE r.post_id IS NOT NULL GROUP BY r.post_id
),
comment_reports AS (
  SELECT r.comment_id AS target_id, count(*)::int AS report_count,
         min(r.created_at) AS oldest_report_at, max(r.created_at) AS newest_report_at,
         max(${SEVERITY_CASE}) AS severity_rank
    FROM reports r WHERE r.comment_id IS NOT NULL GROUP BY r.comment_id
)
SELECT 'post' AS kind, pr.target_id, p.title AS excerpt, p.hidden_at,
       pr.report_count, pr.severity_rank, pr.oldest_report_at
  FROM post_reports pr JOIN posts p ON p.id = pr.target_id
 WHERE NOT EXISTS (SELECT 1 FROM moderation_actions ma
                    WHERE ma.post_id = pr.target_id
                      AND ma.action LIKE 'content\\_%'
                      AND ma.created_at > pr.newest_report_at)
UNION ALL
SELECT 'comment' AS kind, cr.target_id, left(c.body_markdown, 120) AS excerpt, c.hidden_at,
       cr.report_count, cr.severity_rank, cr.oldest_report_at
  FROM comment_reports cr JOIN comments c ON c.id = cr.target_id
 WHERE NOT EXISTS (SELECT 1 FROM moderation_actions ma
                    WHERE ma.comment_id = cr.target_id
                      AND ma.action LIKE 'content\\_%'
                      AND ma.created_at > cr.newest_report_at)
 ORDER BY severity_rank DESC, report_count DESC, oldest_report_at ASC
 LIMIT $1`;

export async function listOpenQueue(c: Client, limit = QUEUE_PAGE_SIZE): Promise<QueueItem[]> {
  const { rows } = await c.query<QueueRow>(SELECT_OPEN_QUEUE, [limit]);
  return rows.map((r) => ({
    kind: r.kind,
    targetId: r.target_id,
    excerpt: r.excerpt,
    hiddenAt: r.hidden_at,
    reportCount: r.report_count,
    severityRank: r.severity_rank,
    oldestReportAt: r.oldest_report_at,
  }));
}
