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
CREATE TABLE dsa_notices (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  reporter_email       citext NOT NULL,
  reporter_name        text NOT NULL,
  good_faith           boolean NOT NULL,
  email_verified_at    timestamptz,          -- NULL = unconfirmed: INERT until set
  verify_token_hash    text NOT NULL UNIQUE, -- SHA-256 of the emailed token; never the token
  post_id              uuid REFERENCES posts(id)    ON DELETE CASCADE,
  comment_id           uuid REFERENCES comments(id) ON DELETE CASCADE,
  reason               text NOT NULL,
  statement            text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  resolution_action_id uuid,                 -- bare: the content_* decision that resolved it
  CONSTRAINT dsa_notices_one_target CHECK ((post_id IS NULL) <> (comment_id IS NULL)),
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
DROP TABLE IF EXISTS dsa_notices;
