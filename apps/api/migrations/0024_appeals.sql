-- Up Migration
--
-- #113 plan B — appeals (spec §3.4, §6) and the per-purpose tokens that let a
-- user who cannot sign in (suspended/banned) appeal, or ask for deletion
-- (#50 Q4), from the notice email.
--
-- appeals: spec §3.4, with two changes. UNIQUE (action_id) rather than
-- (appellant_id, action_id): an action has exactly one subject, so the two are
-- equivalent, and this one says what is meant. And `outcome` /
-- `resolution_action_id`, so a grant's inverse can be computed from state
-- (plan B Task 6) without re-reading every log row.
CREATE TABLE appeals (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  appellant_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- RESTRICT: you cannot delete the action an appeal is about (moot today —
  -- moderation_actions refuses DELETE outright — but it states the intent).
  action_id            uuid NOT NULL REFERENCES moderation_actions(id) ON DELETE RESTRICT,
  body                 text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  outcome              text,
  -- Bare uuid: the appeal_granted / appeal_denied row.
  resolution_action_id uuid,
  CONSTRAINT appeals_one_per_action UNIQUE (action_id),
  CONSTRAINT appeals_body_check CHECK (length(btrim(body)) > 0 AND length(body) <= 5000),
  CONSTRAINT appeals_resolution_consistent CHECK (
    (resolved_at IS NULL AND outcome IS NULL AND resolution_action_id IS NULL)
    OR (resolved_at IS NOT NULL AND outcome IN ('granted', 'denied') AND resolution_action_id IS NOT NULL)
  )
);
CREATE INDEX appeals_open_idx ON appeals (created_at) WHERE resolved_at IS NULL;

-- One row per emailed link. ⚠️ PER PURPOSE (PM ruling): an `appeal` token can
-- never be redeemed as a `delete_request`, or the reverse — the consuming
-- UPDATE matches on purpose. Only the SHA-256 of the token is stored.
CREATE TABLE moderation_action_tokens (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  action_id  uuid NOT NULL REFERENCES moderation_actions(id) ON DELETE RESTRICT,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('appeal', 'delete_request')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  -- NULL = still redeemable. Set exactly once, by the consuming UPDATE.
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_action_tokens_user_idx ON moderation_action_tokens (user_id, created_at);

-- Down Migration
DROP TABLE IF EXISTS moderation_action_tokens;
DROP TABLE IF EXISTS appeals;
