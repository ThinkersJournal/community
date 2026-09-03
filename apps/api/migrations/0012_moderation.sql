-- Up Migration

-- BLOCKS — mirrors follows (0003_social_graph.sql). Block is
-- INTERACTION-CONTROL, not content invisibility (design doc
-- docs/superpowers/specs/2026-09-02-m4-report-block-design.md §2): it does not
-- hide the blocker's public posts/profile from the blocked user. The
-- enforcement predicate is "is <actor> blocked by <target>?", i.e.
-- EXISTS (SELECT 1 FROM blocks WHERE blocker_id = <target> AND blocked_id = <actor>),
-- so the lookup index is (blocked_id, blocker_id).
CREATE TABLE blocks (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- No self-block, DB-enforced (an app guard alone is raceable under a pooler).
  CONSTRAINT blocks_no_self CHECK (blocker_id <> blocked_id),
  -- Membership + idempotency (ON CONFLICT target).
  CONSTRAINT blocks_pair_unique UNIQUE (blocker_id, blocked_id)
);
-- Enforcement predicate is "is <actor> blocked by <target>?": index the lookup.
CREATE INDEX blocks_blocked_blocker_idx ON blocks (blocked_id, blocker_id);

-- REPORTS — dual-nullable-FK one-target shape mirrors reactions
-- (0004_engagement.sql). `reason` is text + CHECK (adding a reason later is an
-- additive CHECK swap, no enum type migration).
CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     uuid REFERENCES posts(id)    ON DELETE CASCADE,
  comment_id  uuid REFERENCES comments(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_one_target CHECK ((post_id IS NULL) <> (comment_id IS NULL)),
  CONSTRAINT reports_reason_valid CHECK (reason IN
    ('spam','harassment','hate','sexual','violence','ip_infringement','other')),
  -- One report per reporter per target (dedup; the auto-hide count is DISTINCT
  -- reporters, and this makes each row already one distinct reporter).
  CONSTRAINT reports_reporter_post_unique    UNIQUE (reporter_id, post_id),
  CONSTRAINT reports_reporter_comment_unique UNIQUE (reporter_id, comment_id)
);
-- The auto-hide threshold query counts reporters on a target in a time window:
CREATE INDEX reports_post_created_idx    ON reports (post_id, created_at)    WHERE post_id IS NOT NULL;
CREATE INDEX reports_comment_created_idx ON reports (comment_id, created_at) WHERE comment_id IS NOT NULL;

-- AUTO-HIDE COLUMNS (additive; no hidden/hidden_at column exists today). Set
-- when a target draws AUTO_HIDE_REPORTER_THRESHOLD distinct reporters within
-- 24h (decision #14); global, not per-viewer. Author-facing "hidden pending
-- review" state and the moderation queue are a later M4 module.
ALTER TABLE posts    ADD COLUMN hidden_at timestamptz;
ALTER TABLE comments ADD COLUMN hidden_at timestamptz;

-- Down Migration
ALTER TABLE comments DROP COLUMN IF EXISTS hidden_at;
ALTER TABLE posts    DROP COLUMN IF EXISTS hidden_at;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS blocks;
