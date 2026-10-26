-- Up Migration
-- DMCA takedown, counter-notice and repeat-infringer flow (ROADMAP R9 / S2;
-- design note docs/superpowers/specs/2026-10-25-dmca-flow-design.md; CireSnave
-- 2026-10-25: "build the full mechanism for US safe-harbour").
--
-- ONE migration for the whole feature, so CireSnave applies it once: the intake
-- PR uses `dmca_notices` first and the later PRs (decision, counter-notice,
-- restore timer, strikes) only add code. Every number the attorney may change
-- (the restore wait, the strike threshold) is a constant in code, not a column.
--
-- ⚠️ SEPARATE from `dsa_notices` and `reports`. A DMCA notice carries the six
-- 17 U.S.C. §512(c)(3) elements and a lifecycle (takedown, counter-notice,
-- restore); AC-1 still holds for it: nothing here feeds auto-hide.
--
-- Same FK reasoning as 0020: `post_id` / `comment_id` are ON DELETE SET NULL, so
-- an author deleting the post cannot make a notice disappear; `target_label` is
-- the title / first 120 characters taken at intake.
--
-- Bare uuids (no FK) for `takedown_action_id` and `subject_user_id`: the audit
-- log and the strike record outlive the account and the content, as in 0013.
CREATE TABLE dmca_notices (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  -- The complainant, and the §512(c)(3)(A) elements as the form collects them.
  complainant_email    citext      NOT NULL,
  complainant_name     text        NOT NULL,
  complainant_address  text        NOT NULL,  -- (iv)
  complainant_phone    text        NOT NULL,  -- (iv)
  signature            text        NOT NULL,  -- (i) typed physical or electronic signature
  work_description     text        NOT NULL,  -- (ii) the copyrighted work
  statement_good_faith boolean     NOT NULL,  -- (v)
  statement_accuracy   boolean     NOT NULL,  -- (vi) accurate, and authorised, under penalty of perjury
  -- Email confirmation, exactly as dsa_notices: unconfirmed = INERT.
  email_verified_at    timestamptz,
  verify_token_hash    text        NOT NULL UNIQUE,
  -- (iii) the material.
  target_kind          text        NOT NULL,
  target_label         text        NOT NULL,
  post_id              uuid REFERENCES posts(id)    ON DELETE SET NULL,
  comment_id           uuid REFERENCES comments(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Lifecycle. pending -> taken_down | rejected; taken_down -> counter_received
  -- -> restored; taken_down -> withdrawn (claimant withdraws).
  state                text        NOT NULL DEFAULT 'pending',
  decided_at           timestamptz,
  decided_by           text,                  -- Access identity, as moderation_actions.actor_admin
  takedown_action_id   uuid,
  subject_user_id      uuid,                  -- the author at takedown; the strike key
  counter_token_hash   text UNIQUE,           -- SHA-256 of the author's counter-notice link token
  counter_received_at  timestamptz,
  restore_after        timestamptz,           -- when the restore timer may act
  restored_at          timestamptz,
  claimant_sued_at     timestamptz,           -- a moderator recorded that the claimant filed suit
  CONSTRAINT dmca_notices_target_kind_valid CHECK (target_kind IN ('post','comment')),
  CONSTRAINT dmca_notices_one_target CHECK
    ((target_kind = 'post' AND comment_id IS NULL) OR (target_kind = 'comment' AND post_id IS NULL)),
  CONSTRAINT dmca_notices_state_valid CHECK
    (state IN ('pending','taken_down','rejected','counter_received','restored','withdrawn')),
  CONSTRAINT dmca_notices_statements_check CHECK (statement_good_faith AND statement_accuracy),
  CONSTRAINT dmca_notices_lengths_check CHECK (
    length(btrim(complainant_name)) BETWEEN 1 AND 200
    AND length(btrim(complainant_address)) BETWEEN 1 AND 500
    AND length(btrim(complainant_phone)) BETWEEN 1 AND 50
    AND length(btrim(signature)) BETWEEN 1 AND 200
    AND length(btrim(work_description)) BETWEEN 1 AND 5000
  )
);
CREATE INDEX dmca_notices_open_idx ON dmca_notices (created_at)
  WHERE email_verified_at IS NOT NULL AND state = 'pending';
CREATE INDEX dmca_notices_restore_idx ON dmca_notices (restore_after)
  WHERE state = 'counter_received' AND claimant_sued_at IS NULL;
CREATE INDEX dmca_notices_subject_idx ON dmca_notices (subject_user_id, decided_at)
  WHERE subject_user_id IS NOT NULL;
CREATE INDEX dmca_notices_post_idx    ON dmca_notices (post_id)    WHERE post_id IS NOT NULL;
CREATE INDEX dmca_notices_comment_idx ON dmca_notices (comment_id) WHERE comment_id IS NOT NULL;
-- The reaper's predicate.
CREATE INDEX dmca_notices_unconfirmed_idx ON dmca_notices (created_at) WHERE email_verified_at IS NULL;

-- The author's counter-notice, §512(g)(3). One per notice.
CREATE TABLE dmca_counter_notices (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  notice_id           uuid        NOT NULL UNIQUE REFERENCES dmca_notices(id) ON DELETE CASCADE,
  author_name         text        NOT NULL,
  author_address      text        NOT NULL,
  author_phone        text        NOT NULL,
  signature           text        NOT NULL,   -- (A) typed signature
  statement_mistake   boolean     NOT NULL,   -- (C) good-faith belief of mistake or misidentification, under penalty of perjury
  consent_jurisdiction boolean    NOT NULL,   -- (D) consent to the federal court, and to accept service
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dmca_counter_statements_check CHECK (statement_mistake AND consent_jurisdiction),
  CONSTRAINT dmca_counter_lengths_check CHECK (
    length(btrim(author_name)) BETWEEN 1 AND 200
    AND length(btrim(author_address)) BETWEEN 1 AND 500
    AND length(btrim(author_phone)) BETWEEN 1 AND 50
    AND length(btrim(signature)) BETWEEN 1 AND 200
  )
);

-- A DMCA decision is an ordinary content ruling (content_remove / content_restore)
-- that says what prompted it: source 'dmca_notice', with the notice's id.
ALTER TABLE moderation_actions ADD COLUMN dmca_notice_id uuid;
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_source_valid;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_source_valid
  CHECK (source IN ('dsa_notice','member_report','own_initiative','dmca_notice'));
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_dmca_needs_source
  CHECK (dmca_notice_id IS NULL OR source IS NOT DISTINCT FROM 'dmca_notice');

-- The notice outbox gets the two DMCA kinds (a takedown / restore notice to the
-- author, and an outcome / counter-notice copy to the claimant).
ALTER TABLE moderation_notice_outbox DROP CONSTRAINT moderation_notice_outbox_kind_valid;
ALTER TABLE moderation_notice_outbox ADD CONSTRAINT moderation_notice_outbox_kind_valid
  CHECK (kind IN ('author_decision','author_auto_hide','account_action','appeal_outcome','reporter_outcome',
                  'dmca_author_notice','dmca_claimant_notice'));

-- Down Migration
-- Fails while any dmca-sourced action or DMCA outbox row exists: moderation_actions
-- is append-only (0013) and a down migration is never automated (docs/runbooks/deploy.md).
ALTER TABLE moderation_notice_outbox DROP CONSTRAINT moderation_notice_outbox_kind_valid;
ALTER TABLE moderation_notice_outbox ADD CONSTRAINT moderation_notice_outbox_kind_valid
  CHECK (kind IN ('author_decision','author_auto_hide','account_action','appeal_outcome','reporter_outcome'));
ALTER TABLE moderation_actions DROP CONSTRAINT IF EXISTS moderation_actions_dmca_needs_source;
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_source_valid;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_source_valid
  CHECK (source IN ('dsa_notice','member_report','own_initiative'));
ALTER TABLE moderation_actions DROP COLUMN IF EXISTS dmca_notice_id;
DROP TABLE IF EXISTS dmca_counter_notices;
DROP TABLE IF EXISTS dmca_notices;
