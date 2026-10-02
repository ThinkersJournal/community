-- Up Migration
--
-- #58 — a copy of moderated content that survives its author deleting it.
--
-- CireSnave, Q1: "allow the author to delete the post which would hide it from
-- all users. However, keep the content of it somewhere for legal use."
-- CireSnave, Q2: "minimum of 1 year or until a lawyer states it should be
-- removed."
--
-- Written by the author-delete paths (routes/posts.ts handleDeletePost,
-- routes/comments.ts handleDeleteComment) ONLY when the content is under
-- moderation at the moment of deletion — the same definition as #58's edit
-- freeze. Because that freeze stops a hidden post or comment from being edited,
-- the copy taken at delete time IS the version that was hidden.
--
-- ⚠️ BARE uuids, NO FOREIGN KEYS — the same reasoning as moderation_actions
-- (0013): this row exists to OUTLIVE the post, comment and user it describes.
-- ON DELETE CASCADE would destroy the evidence with its subject, and
-- ON DELETE SET NULL is an UPDATE the guard below refuses.
--
-- ⚠️ RETENTION IS A FLOOR, NOT A TIMER (Q2). Nothing in the application deletes
-- these rows: there is no reaper and no cron. The guard refuses any UPDATE,
-- any TRUNCATE, and any DELETE of a row younger than one year. Past one year a
-- row is still kept indefinitely; removing it is a deliberate manual act on
-- legal advice, and even that act cannot reach a row inside its first year.
CREATE TABLE moderation_snapshots (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  post_id       uuid,
  comment_id    uuid,
  author_id     uuid NOT NULL,
  title         text,           -- posts only
  body_markdown text NOT NULL,  -- posts.markdown_source / comments.body_markdown
  captured_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_snapshots_one_target CHECK ((post_id IS NULL) <> (comment_id IS NULL))
);
CREATE INDEX moderation_snapshots_post_idx    ON moderation_snapshots (post_id)    WHERE post_id IS NOT NULL;
CREATE INDEX moderation_snapshots_comment_idx ON moderation_snapshots (comment_id) WHERE comment_id IS NOT NULL;

CREATE FUNCTION moderation_snapshots_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'moderation_snapshots cannot be truncated (#58: kept at least 1 year)';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'moderation_snapshots is immutable';
  END IF;
  IF OLD.captured_at > now() - interval '1 year' THEN
    RAISE EXCEPTION 'moderation_snapshots: a snapshot is kept for at least 1 year (#58)';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER moderation_snapshots_no_update_or_early_delete
  BEFORE UPDATE OR DELETE ON moderation_snapshots
  FOR EACH ROW EXECUTE FUNCTION moderation_snapshots_guard();
CREATE TRIGGER moderation_snapshots_no_truncate
  BEFORE TRUNCATE ON moderation_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION moderation_snapshots_guard();

-- Down Migration
DROP TABLE IF EXISTS moderation_snapshots;
DROP FUNCTION IF EXISTS moderation_snapshots_guard();
