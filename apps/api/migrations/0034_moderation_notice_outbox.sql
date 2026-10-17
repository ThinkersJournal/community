-- Up Migration
-- Moderation notice OUTBOX (#57 gap 1; design: docs/superpowers/specs/
-- 2026-10-15-moderation-notice-outbox-design.md, section 3). A notice is
-- rendered and INSERTed here INSIDE the decision's transaction, so "decision
-- committed" implies "notice queued"; a cron drain (src/moderation/
-- notice-outbox.ts) sends it. The row IS the notice record: it supersedes
-- moderation_notice_records (0032), which stays in place until PR 2 moves the
-- account notices over and its own retain_until has passed.
--
-- ⚠️ ALL FIVE KINDS ARE IN THE CHECK NOW, though only `author_decision` is
-- written by PR 1, so later PRs need no CHECK change.
--
-- ⚠️ NO FOREIGN KEY on `action_id` or `recipient_user_id`, matching 0013/0032:
-- the audit log outlives its subjects, and a record must not make posts or
-- users undeletable. UNIQUE (action_id, kind): a retried enqueue is a no-op
-- (INSERT ... ON CONFLICT (action_id, kind) DO NOTHING).
--
-- ⚠️ PRIVACY. body_text/body_html hold the moderator's reason and a content
-- title. An ACCOUNT recipient's address is NOT stored: it is re-read from
-- `users` at send time (an address change is honoured; an anonymised account
-- is undeliverable with no send). `recipient_email` is for a DSA reporter only
-- (no account) and is nulled when the row reaches delivered/undeliverable.
-- `last_error` is a failure CLASS, never a body or an address. After delivery
-- the live appeal link in the stored body is replaced by a marker.
--
-- Lease shape (leased_until / leased_by) is email_drain_lock's (0008): an
-- opaque per-pass token fences the release.
--
-- RETENTION. retain_until = the decision's created_at +
-- MODERATION_NOTICE_RETENTION_DAYS (packages/shared/src/admin.ts, 365),
-- fixed at write time; a bounded daily purge deletes rows past it.
CREATE TABLE moderation_notice_outbox (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id         uuid NOT NULL,
  kind              text NOT NULL
    CONSTRAINT moderation_notice_outbox_kind_valid
    CHECK (kind IN ('author_decision','author_auto_hide','account_action','appeal_outcome','reporter_outcome')),
  recipient_user_id uuid,
  recipient_email   text,
  subject           text NOT NULL,
  body_text         text NOT NULL,
  body_html         text NOT NULL,
  state             text NOT NULL DEFAULT 'pending'
    CONSTRAINT moderation_notice_outbox_state_valid
    CHECK (state IN ('pending','sending','delivered','undeliverable')),
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  leased_until      timestamptz,
  leased_by         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz,
  last_error        text,
  retain_until      timestamptz NOT NULL,
  CONSTRAINT moderation_notice_outbox_action_kind_key UNIQUE (action_id, kind)
);

-- The drain's scan: only rows that can still be sent.
CREATE INDEX moderation_notice_outbox_due_idx
  ON moderation_notice_outbox (next_attempt_at)
  WHERE state IN ('pending','sending');

-- The purge's scan.
CREATE INDEX moderation_notice_outbox_retain_until_idx ON moderation_notice_outbox (retain_until);

-- Down Migration
DROP INDEX IF EXISTS moderation_notice_outbox_retain_until_idx;
DROP INDEX IF EXISTS moderation_notice_outbox_due_idx;
DROP TABLE IF EXISTS moderation_notice_outbox;
