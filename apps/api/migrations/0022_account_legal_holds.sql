-- Up Migration
-- Account legal holds (account-legal-hold spec §2/§3, board item 91).
--
-- Deletion eligibility (both reapers) is gated on an ACTIVE row in this
-- table, and on nothing else: `disabled_at`/`suspended_until` become pure
-- access control. Holds come from a legal-hold content decision (T1), CSAM
-- intake (T2, #114), and a manual two-admin admin action (T3).
--
-- Mirrors media_legal_holds's append-only shape, but a hold here can be
-- RELEASED (a DMCA or other hold may legitimately end; CSAM never does).
-- `user_id` is bare (evidence outlives its subject, same reasoning as 0013).
CREATE TABLE account_legal_holds (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id              uuid NOT NULL,
  category             text NOT NULL CHECK (category IN ('csam', 'dmca', 'other')),
  imposed_by           text NOT NULL,
  moderation_action_id uuid,
  reason               text NOT NULL,
  imposed_at           timestamptz NOT NULL DEFAULT now(),
  released_at          timestamptz,
  released_by          text,
  release_reason       text,
  CONSTRAINT account_legal_holds_release_consistent CHECK (
    (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND released_by IS NOT NULL AND release_reason IS NOT NULL)),
  -- ⚠️ CSAM holds are never released by the app (legal-hold.ts's rule, mirrored).
  CONSTRAINT account_legal_holds_csam_never_released CHECK (category <> 'csam' OR released_at IS NULL)
);
-- At most one ACTIVE hold per (user, category); history is kept.
CREATE UNIQUE INDEX account_legal_holds_active_idx ON account_legal_holds (user_id, category) WHERE released_at IS NULL;

CREATE FUNCTION account_legal_holds_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'account_legal_holds is append-only (release by UPDATE of the release columns)';
  END IF;
  -- UPDATE: only a release of a currently-active hold, and only the three release columns change.
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'account_legal_holds: a released hold is final';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.category IS DISTINCT FROM OLD.category OR NEW.imposed_by IS DISTINCT FROM OLD.imposed_by
     OR NEW.moderation_action_id IS DISTINCT FROM OLD.moderation_action_id
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.imposed_at IS DISTINCT FROM OLD.imposed_at THEN
    RAISE EXCEPTION 'account_legal_holds: only released_at/released_by/release_reason may change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER account_legal_holds_row_guard BEFORE UPDATE OR DELETE ON account_legal_holds
  FOR EACH ROW EXECUTE FUNCTION account_legal_holds_guard();
CREATE TRIGGER account_legal_holds_no_truncate BEFORE TRUNCATE ON account_legal_holds
  FOR EACH STATEMENT EXECUTE FUNCTION account_legal_holds_guard();

-- A banned account's address is reserved by a hash while the ban stands (spec
-- §4a, PM ruling B). Only a deleted account reserves anything; a live row's
-- own email already does that job. NOT unique: two anonymised accounts may
-- share a hash (§4a says why).
ALTER TABLE users
  ADD COLUMN reserved_email_sha256 text NULL,
  ADD CONSTRAINT users_reserved_email_sha256_hex
    CHECK (reserved_email_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT users_reserved_email_only_anonymised
    CHECK (reserved_email_sha256 IS NULL OR anonymised_at IS NOT NULL);
CREATE INDEX users_reserved_email_sha256_idx ON users (reserved_email_sha256)
  WHERE reserved_email_sha256 IS NOT NULL;

-- New moderation_actions kinds: account_hold, account_hold_release (T1/T2/T3).
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    -- Latest list, from 0017 (0020/0021 did not touch this constraint), plus
    -- this migration's additions.
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide',
    'account_hold','account_hold_release'
  ));

-- Backfill (spec §5, AH-5): terminations made before holds existed must stay
-- undeletable. Idempotent. ⚠️ Keep this statement byte-identical to
-- BACKFILL_TERMINATED_HOLDS_SQL in src/moderation/account-holds.ts — the
-- schema test runs that constant to prove this statement.
INSERT INTO account_legal_holds (user_id, category, imposed_by, reason)
SELECT id, 'csam', 'system', 'backfill: terminated before account holds existed'
  FROM users WHERE disabled_reason = 'terminate'
ON CONFLICT (user_id, category) WHERE released_at IS NULL DO NOTHING;

-- Down Migration
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide'
  ));

DROP INDEX IF EXISTS users_reserved_email_sha256_idx;
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_reserved_email_only_anonymised,
  DROP CONSTRAINT IF EXISTS users_reserved_email_sha256_hex,
  DROP COLUMN IF EXISTS reserved_email_sha256;

DROP TRIGGER IF EXISTS account_legal_holds_no_truncate ON account_legal_holds;
DROP TRIGGER IF EXISTS account_legal_holds_row_guard ON account_legal_holds;
DROP FUNCTION IF EXISTS account_legal_holds_guard();
DROP TABLE IF EXISTS account_legal_holds;
