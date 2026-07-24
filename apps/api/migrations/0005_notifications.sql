-- Up Migration

-- IN-APP NOTIFICATIONS — the source of record (architecture §9). One row per
-- event; collapsing is a read-time display concern (no aggregate rows here).
-- The unique natural key makes writes idempotent AND anti-spam: each
-- (recipient, actor, kind, target, tone) notifies at most once ever, so a
-- react/unreact or follow/unfollow loop cannot spam a bell, and an at-least-once
-- delivery path (M2.3b) can retry safely.
CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  recipient_id  uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  actor_id      uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN
                  ('post_comment','comment_reply','post_reaction','comment_reaction','follow')),
  post_id       uuid REFERENCES posts(id)    ON DELETE CASCADE,
  comment_id    uuid REFERENCES comments(id) ON DELETE CASCADE,
  -- Display metadata copied from reactions.kind (which owns the tone CHECK); not
  -- re-constrained here to avoid a second place to edit when a tone is added.
  reaction_kind text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  CONSTRAINT notifications_no_self CHECK (recipient_id <> actor_id),
  CONSTRAINT notifications_event_unique
    UNIQUE NULLS NOT DISTINCT (recipient_id, actor_id, kind, post_id, comment_id, reaction_kind)
);

-- The keyset list: "my notifications, newest first".
CREATE INDEX notifications_recipient_id_desc_idx ON notifications (recipient_id, id DESC);
-- The polled badge: partial index keeps unread COUNT(*) cheap.
CREATE INDEX notifications_unread_idx ON notifications (recipient_id) WHERE read_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS notifications;
