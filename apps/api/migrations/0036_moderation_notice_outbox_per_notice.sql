-- Up Migration
-- Moderation notice outbox PR 2 (design: docs/superpowers/specs/
-- 2026-10-15-moderation-notice-outbox-design.md, sections 2 and 3).
--
-- One ruling can resolve SEVERAL confirmed DSA notices (decide.ts links the
-- oldest from the action row, but every notice gets its reporter an outcome).
-- 0034's UNIQUE (action_id, kind) would keep only the first reporter's row, so
-- a reporter kind is made unique per (action_id, kind, dsa_notice_id) instead.
-- Every other kind keeps exactly the old rule: one row per (action_id, kind).
--
-- ⚠️ NO FOREIGN KEY on dsa_notice_id, matching the rest of this table: the
-- notice is reaped or purged on its own clock and must not be pinned by (or
-- cascade into) a retained record.
--
-- The conflict arbiter is now two PARTIAL unique indexes, so inserts use a bare
-- ON CONFLICT DO NOTHING (any unique violation = an already-queued notice).
ALTER TABLE moderation_notice_outbox ADD COLUMN dsa_notice_id uuid;

ALTER TABLE moderation_notice_outbox DROP CONSTRAINT moderation_notice_outbox_action_kind_key;

CREATE UNIQUE INDEX moderation_notice_outbox_action_kind_key
  ON moderation_notice_outbox (action_id, kind)
  WHERE dsa_notice_id IS NULL;

CREATE UNIQUE INDEX moderation_notice_outbox_action_kind_notice_key
  ON moderation_notice_outbox (action_id, kind, dsa_notice_id)
  WHERE dsa_notice_id IS NOT NULL;

-- Down Migration
DELETE FROM moderation_notice_outbox WHERE dsa_notice_id IS NOT NULL;
DROP INDEX IF EXISTS moderation_notice_outbox_action_kind_notice_key;
DROP INDEX IF EXISTS moderation_notice_outbox_action_kind_key;
ALTER TABLE moderation_notice_outbox
  ADD CONSTRAINT moderation_notice_outbox_action_kind_key UNIQUE (action_id, kind);
ALTER TABLE moderation_notice_outbox DROP COLUMN IF EXISTS dsa_notice_id;
