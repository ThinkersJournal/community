-- Up Migration
--
-- DSA notice-and-action intake (spec §3.3, §8; decision #6). A SEPARATE table
-- from `reports`, deliberately: reports.reporter_id is a NOT NULL member FK and
-- auto-hide counts DISTINCT member reporters from it. ⚠️ AC-1: nothing reads
-- this table when deciding auto-hide, and nothing must ever start to.
--
-- Two fields beyond spec §3.3, because DSA Art. 16(2) requires a notice to
-- carry them: the reporter's NAME (16(2)(c)) and a statement of good faith
-- (16(2)(d)). The URL (16(2)(b)) is the target id; the explanation (16(2)(a))
-- is `statement`.
--
-- ⚠️ Ruling 2026-10-01 (PM, final-review addendum to #113 plan C): `post_id`/
-- `comment_id` are `ON DELETE SET NULL`, NOT CASCADE. DSA Art. 16(5)/17
-- require an outcome to the reporter whatever happens to the content — an
-- author must not be able to make a CONFIRMED notice disappear, with it,
-- simply by deleting the post or comment it was filed against. `target_kind`
-- records which column the notice was against (so a notice whose column has
-- gone to NULL is still identifiable), and `target_label` is a snapshot of
-- the post title / first 120 characters of the comment body taken AT INTAKE,
-- so the admin list and the reporter-facing emails can still name the
-- content after it is gone. This migration is unmerged at the time of this
-- ruling, so it is edited in place rather than superseded by a new one.
CREATE TABLE dsa_notices (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  reporter_email       citext NOT NULL,
  reporter_name        text NOT NULL,
  good_faith           boolean NOT NULL,
  email_verified_at    timestamptz,          -- NULL = unconfirmed: INERT until set
  verify_token_hash    text NOT NULL UNIQUE, -- SHA-256 of the emailed token; never the token
  target_kind          text NOT NULL CHECK (target_kind IN ('post','comment')),
  target_label         text NOT NULL,        -- snapshot at intake; survives the target's deletion
  post_id              uuid REFERENCES posts(id)    ON DELETE SET NULL,
  comment_id           uuid REFERENCES comments(id) ON DELETE SET NULL,
  reason               text NOT NULL,
  statement            text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  resolution_action_id uuid,                 -- bare: the content_* decision that resolved it
  -- At most the kind's OWN column may be set, and — because of SET NULL
  -- above — it may be NULL after the target is deleted even though the row
  -- is still "a post notice" or "a comment notice" by `target_kind`.
  CONSTRAINT dsa_notices_one_target CHECK
    ((target_kind = 'post' AND comment_id IS NULL) OR (target_kind = 'comment' AND post_id IS NULL)),
  CONSTRAINT dsa_notices_reason_check CHECK (reason IN
    ('spam','harassment','hate','sexual','violence','ip_infringement','other')),
  CONSTRAINT dsa_notices_statement_check CHECK (length(btrim(statement)) > 0 AND length(statement) <= 5000),
  CONSTRAINT dsa_notices_reporter_name_check CHECK (length(btrim(reporter_name)) > 0 AND length(reporter_name) <= 200),
  CONSTRAINT dsa_notices_good_faith_check CHECK (good_faith)
);
CREATE INDEX dsa_notices_open_idx ON dsa_notices (created_at)
  WHERE email_verified_at IS NOT NULL AND resolved_at IS NULL;
CREATE INDEX dsa_notices_post_idx ON dsa_notices (post_id) WHERE post_id IS NOT NULL;
CREATE INDEX dsa_notices_comment_idx ON dsa_notices (comment_id) WHERE comment_id IS NOT NULL;
-- The reaper's predicate.
CREATE INDEX dsa_notices_unconfirmed_idx ON dsa_notices (created_at) WHERE email_verified_at IS NULL;

-- Down Migration
--
-- Unchanged by the SET NULL ruling above: the down migration drops the whole
-- table, so it is agnostic to the FK action and the two added columns.
DROP TABLE IF EXISTS dsa_notices;
