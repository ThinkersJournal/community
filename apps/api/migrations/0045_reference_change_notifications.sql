-- Up Migration
-- Reference-change notifications (M3.9; design docs/superpowers/specs/2026-11-19-m3-9-reference-change-notifications.md, schema A).
-- A reference refresh that finds a linked page gone or changed tells the authors of the published posts that use it. That
-- event has no actor, so `notifications.actor_id` becomes nullable and the table learns what it is about:
--   * kind gains `reference_changed`;
--   * `reference_id` points at the shared `"references"` row (the notification dies with it), `reference_event` is `gone` or
--     `changed:<content_hash>` so a flapping resource notifies once per distinct state, never again for the same one;
--   * the unique key `notifications_event_unique` is dropped and re-added to include both. The table is PRE-LAUNCH (a few
--     rows at most, none of the new kind), so the drop-and-add is cheap and holds no meaningful lock. The new key is a
--     strict superset of the old: every existing row has NULL in both new columns, and NULLS NOT DISTINCT keeps those
--     rows colliding exactly as before. notify() still names the constraint, so its ON CONFLICT is unchanged;
--   * notifications_shape ties the three together: a reference_changed row has no actor and has a reference and an event;
--     every other kind has an actor (this replaces the NOT NULL the column used to carry).
-- notifications_no_self (recipient_id <> actor_id) is untouched: it passes when actor_id is NULL.
-- NO snapshot text is ever stored here: the row says THAT something changed, never what the page now says.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN
  ('post_comment','comment_reply','post_reaction','comment_reaction','follow','reference_changed'));

ALTER TABLE notifications ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN reference_id uuid REFERENCES "references"(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN reference_event text;

ALTER TABLE notifications DROP CONSTRAINT notifications_event_unique;
ALTER TABLE notifications ADD CONSTRAINT notifications_event_unique
  UNIQUE NULLS NOT DISTINCT (recipient_id, actor_id, kind, post_id, comment_id, reaction_kind, reference_id, reference_event);

ALTER TABLE notifications ADD CONSTRAINT notifications_reference_event_shape
  CHECK (reference_event IS NULL OR reference_event = 'gone' OR reference_event LIKE 'changed:%');
ALTER TABLE notifications ADD CONSTRAINT notifications_shape CHECK (
  (kind = 'reference_changed' AND actor_id IS NULL AND reference_id IS NOT NULL AND reference_event IS NOT NULL)
  OR (kind <> 'reference_changed' AND actor_id IS NOT NULL)
);

-- The per-author rolling-day cap counts an author's reference notifications by recipient and age.
CREATE INDEX notifications_reference_cap_idx ON notifications (recipient_id, created_at) WHERE kind = 'reference_changed';

-- Down Migration
-- Deletes the new kind's rows (they cannot exist under the old shape), then restores 0005's constraints. A down migration is
-- never automated (docs/runbooks/deploy.md).
DROP INDEX IF EXISTS notifications_reference_cap_idx;
DELETE FROM notifications WHERE kind = 'reference_changed';
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_shape;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_reference_event_shape;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_event_unique;
ALTER TABLE notifications DROP COLUMN IF EXISTS reference_event;
ALTER TABLE notifications DROP COLUMN IF EXISTS reference_id;
ALTER TABLE notifications ADD CONSTRAINT notifications_event_unique
  UNIQUE NULLS NOT DISTINCT (recipient_id, actor_id, kind, post_id, comment_id, reaction_kind);
ALTER TABLE notifications ALTER COLUMN actor_id SET NOT NULL;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN
  ('post_comment','comment_reply','post_reaction','comment_reaction','follow'));
