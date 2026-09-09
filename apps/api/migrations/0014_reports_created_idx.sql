-- Up Migration
-- The moderation queue (module 2b) orders open items globally by recency.
--
-- ⚠️ 0012 gave `reports` only PARTIAL indexes — (post_id, created_at) WHERE
-- post_id IS NOT NULL, and the comment equivalent. Neither can serve an
-- ordering across BOTH target kinds, and neither covers a scan by time alone.
--
-- The 2026-09-06 design says migration 0013 adds this. It did not: 0013's four
-- indexes are all on moderation_actions. The 2a task brief was scoped to that
-- table and the review checked the implementation against the brief rather than
-- against the design, so the gap survived both. It is created here.
CREATE INDEX reports_created_idx ON reports (created_at);

-- Down Migration
DROP INDEX IF EXISTS reports_created_idx;
