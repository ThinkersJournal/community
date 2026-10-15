-- Up Migration
-- #57 Q9 (DSA Art. 17), PR-D: keep the RENDERED text of every statement of
-- reasons we actually sent, so "what exactly were they told?" is answerable
-- long after the moderator's wording or our templates change.
--
-- ⚠️ A PLAIN TABLE, written best-effort by the code path that sends the notice
-- (routes/admin.ts, routes/admin-accounts.ts). The moderation notice OUTBOX
-- (#57 gap 1) has not landed; when it does it can write here instead.
--
-- ⚠️ NO FOREIGN KEY on `action_id`, matching 0013's stance: the audit log
-- outlives its subjects, and a record must not make posts or users undeletable.
-- UNIQUE(action_id): one notice per action; a retried write is a no-op.
--
-- ⚠️ PRIVACY. `body_text`/`body_html` contain the moderator's reason and the
-- author's content title. There is NO read route for this table, deliberately;
-- any future reader must be admin-only. The recipient's address is NOT stored
-- and neither is a user id, so a row is linked to a person only through
-- moderation_actions.subject_user_id.
--
-- ⚠️ RETENTION. `retain_until` = the decision's created_at + the constant
-- MODERATION_NOTICE_RETENTION_DAYS (packages/shared/src/admin.ts, 730 days:
-- PROVISIONAL, CireSnave guessed "one to two years" and has yet to determine
-- it). A bounded daily purge (src/moderation/notice-records.ts) deletes rows
-- past it. Fixed at write time, so a changed constant affects new rows only.
--
-- ⚠️ OPEN QUESTION (not decided here): account anonymisation does NOT scrub
-- these rows. They are retained to their `retain_until` like the audit log
-- they mirror, and carry no direct identifier. Whether the legal-retention
-- period overrides an erasure request for the reason text is CireSnave's call
-- (with the retention period itself).
CREATE TABLE moderation_notice_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id    uuid NOT NULL UNIQUE,
  kind         text NOT NULL CONSTRAINT moderation_notice_records_kind_valid CHECK (kind IN ('author','account')),
  subject      text NOT NULL,
  body_text    text NOT NULL,
  body_html    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL
);

-- The purge's scan.
CREATE INDEX moderation_notice_records_retain_until_idx ON moderation_notice_records (retain_until);

-- Down Migration
DROP INDEX IF EXISTS moderation_notice_records_retain_until_idx;
DROP TABLE IF EXISTS moderation_notice_records;
