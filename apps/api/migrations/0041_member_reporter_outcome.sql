-- Up Migration
-- S14(c) (CireSnave 2026-10-25, via the PM): a member who uses the ordinary Report
-- button is told the outcome, as a person who files a DSA notice already is.
--
-- 1. `reports.outcome_action_id`: the ruling that answered this report. Set in the
--    same transaction as the ruling (decide.ts), and only while NULL, so a later
--    ruling on the same content never answers (or emails) the same report twice.
--    Bare uuid, no FK, as in 0013/0034: the audit log outlives its subjects, and a
--    referential action here would be an UPDATE the append-only trigger refuses.
--    Reports already on file stay NULL: the first ruling after this migration
--    answers them, which is true to what they were waiting for.
-- 2. A new outbox kind, `member_reporter_outcome`: one row per reporter per ruling,
--    addressed to the reporter's ACCOUNT (the address is re-read at send time, as
--    for an author). It carries the outcome only, never the author's reason.
-- 3. The outbox's one-row-per-(action, kind) unique index (0036) would allow only
--    the first member reporter, so it no longer applies to this kind; a second
--    unique index keeps it to one row per (action, reporter).
--
-- ⚠️ ADDITIVE and inert for the old code: apply BEFORE the code that writes it
-- merges (docs/runbooks/deploy.md, "Shipping a PR with an additive migration").
ALTER TABLE reports ADD COLUMN outcome_action_id uuid;

ALTER TABLE moderation_notice_outbox DROP CONSTRAINT moderation_notice_outbox_kind_valid;
ALTER TABLE moderation_notice_outbox ADD CONSTRAINT moderation_notice_outbox_kind_valid
  CHECK (kind IN ('author_decision','author_auto_hide','account_action','appeal_outcome','reporter_outcome',
                  'dmca_author_notice','dmca_claimant_notice','member_reporter_outcome'));

DROP INDEX moderation_notice_outbox_action_kind_key;
CREATE UNIQUE INDEX moderation_notice_outbox_action_kind_key
  ON moderation_notice_outbox (action_id, kind)
  WHERE dsa_notice_id IS NULL AND kind <> 'member_reporter_outcome';
CREATE UNIQUE INDEX moderation_notice_outbox_member_reporter_key
  ON moderation_notice_outbox (action_id, recipient_user_id)
  WHERE kind = 'member_reporter_outcome';

-- Down Migration
DELETE FROM moderation_notice_outbox WHERE kind = 'member_reporter_outcome';
DROP INDEX IF EXISTS moderation_notice_outbox_member_reporter_key;
DROP INDEX IF EXISTS moderation_notice_outbox_action_kind_key;
CREATE UNIQUE INDEX moderation_notice_outbox_action_kind_key
  ON moderation_notice_outbox (action_id, kind)
  WHERE dsa_notice_id IS NULL;
ALTER TABLE moderation_notice_outbox DROP CONSTRAINT moderation_notice_outbox_kind_valid;
ALTER TABLE moderation_notice_outbox ADD CONSTRAINT moderation_notice_outbox_kind_valid
  CHECK (kind IN ('author_decision','author_auto_hide','account_action','appeal_outcome','reporter_outcome',
                  'dmca_author_notice','dmca_claimant_notice'));
ALTER TABLE reports DROP COLUMN IF EXISTS outcome_action_id;
