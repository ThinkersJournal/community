-- Up Migration

-- Onboarding gate flag: existing system-username rows keep the default false and
-- are prompted to choose a durable handle before their next publish/follow.
ALTER TABLE profiles ADD COLUMN username_chosen boolean NOT NULL DEFAULT false;

CREATE TABLE follows (
  -- uuidv7 surrogate: the single monotonic cursor column that keyset-paginates
  -- follower/following lists (v7 ids are time-ordered, newest-first is id DESC).
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  follower_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- No self-follow, DB-enforced (an app guard alone is raceable under a pooler).
  CONSTRAINT follows_no_self CHECK (follower_id <> followee_id),
  -- Membership + idempotency (ON CONFLICT target) + "who I follow" (getFolloweeIds).
  CONSTRAINT follows_pair_unique UNIQUE (follower_id, followee_id)
);

-- "who follows X" keyset list + followers_count.
CREATE INDEX follows_followee_id_desc_idx ON follows (followee_id, id DESC);
-- "who X follows" keyset list + following_count.
CREATE INDEX follows_follower_id_desc_idx ON follows (follower_id, id DESC);

-- Down Migration
DROP TABLE IF EXISTS follows;
ALTER TABLE profiles DROP COLUMN IF EXISTS username_chosen;
