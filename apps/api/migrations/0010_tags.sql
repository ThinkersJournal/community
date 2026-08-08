-- Up Migration

-- Freeform post tags (M2.4c). `slug` is citext (like posts.slug) so /tag/AI and
-- /tag/ai are one row / one URL / one cache entry; `label` keeps the first
-- writer's display casing. Tags are created on first use, never deleted here.
CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  slug       citext NOT NULL UNIQUE,
  label      text   NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE post_tags (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id  uuid NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

-- Serves "published posts with this tag, newest first": look up post_tags by
-- tag_id, then join posts (whose posts_published_key gives the id-DESC keyset).
CREATE INDEX post_tags_tag_id_idx ON post_tags (tag_id);

-- Down Migration
DROP TABLE IF EXISTS post_tags;
DROP TABLE IF EXISTS tags;
