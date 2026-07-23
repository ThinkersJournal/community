-- Up Migration

-- THREADED COMMENTS — materialized-path tree. `path` is the ancestor id chain
-- joined by '/', ending in the row's own id (top-level path = id::text).
-- uuid::text is fixed-width and uuidv7 is time-ordered, so lexicographic
-- `ORDER BY path` walks the whole tree in thread order (siblings oldest-first)
-- off one index scan. `path`/`depth` are computed by the api, never client-supplied.
CREATE TABLE comments (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  post_id        uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id      uuid REFERENCES comments(id) ON DELETE CASCADE, -- NULL = top-level
  path           text NOT NULL,
  depth          int  NOT NULL CHECK (depth >= 0 AND depth <= 8),
  -- ⚠️ App-level delete is a TOMBSTONE (deleted_at + body emptied), never a row
  -- DELETE — the row cascades here exist for USER/POST deletion, and a future
  -- account-deletion design must tombstone, not delete (spec §4's cascade note:
  -- deleting a user's rows would take other people's reply subtrees with them).
  body_markdown  text NOT NULL CONSTRAINT comments_body_len CHECK (char_length(body_markdown) <= 10000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  edited_at      timestamptz,
  deleted_at     timestamptz
);

-- The one read path: a post's tree in path order, keyset on path.
CREATE INDEX comments_post_path_idx ON comments (post_id, path);

-- REACTIONS — dual-nullable-FK; exactly one target. `kind` is text + CHECK
-- (adding a tone later = additive CHECK swap, no enum type migration).
CREATE TABLE reactions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     uuid REFERENCES posts(id) ON DELETE CASCADE,
  comment_id  uuid REFERENCES comments(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('insightful','curious','agree','challenging')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reactions_one_target CHECK ((post_id IS NULL) <> (comment_id IS NULL)),
  -- The idempotency anchor (ON CONFLICT target). NULLS NOT DISTINCT is
  -- load-bearing: without it the NULL side of the pair makes every row distinct.
  CONSTRAINT reactions_target_unique UNIQUE NULLS NOT DISTINCT (user_id, post_id, comment_id, kind)
);

-- Count paths: per-post and per-comment GROUP BY kind.
CREATE INDEX reactions_post_idx    ON reactions (post_id);
CREATE INDEX reactions_comment_idx ON reactions (comment_id);

-- Down Migration
DROP TABLE IF EXISTS reactions;
DROP TABLE IF EXISTS comments;
