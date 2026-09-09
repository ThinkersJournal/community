-- Up Migration
-- M4 module 2a: the append-only moderation audit log. The compliance record
-- behind DSA statements of reasons and the evidence base for appeals.
--
-- ⚠️ NO FOREIGN KEYS, DELIBERATELY. `ON DELETE SET NULL` performs an UPDATE on
-- this table, which the immutability trigger below REFUSES -- so FKs here would
-- make posts and users UNDELETABLE and break GDPR erasure. An append-only log
-- must OUTLIVE its subjects; referential actions on it are semantically wrong.
-- A dangling post_id after a post is deleted is CORRECT for an audit record,
-- and `subject_label` preserves the readability a bare uuid loses.
CREATE TABLE moderation_actions (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  -- The Cloudflare Access identity (email) of the human who acted, or 'system'.
  -- Text, not a FK: moderators are Access principals and need not be members.
  actor_admin       text NOT NULL,
  action            text NOT NULL CHECK (action IN (
                      'content_restore','content_keep_hidden','content_remove',
                      'user_warn','user_suspend','user_ban','user_terminate',
                      'appeal_granted','appeal_denied')),
  post_id           uuid,
  comment_id        uuid,
  subject_user_id   uuid,
  subject_label     text,
  violation_category text CHECK (violation_category IN
                      ('spam','harassment','hate','sexual','violence','ip_infringement','other')),
  -- A suspension's intended end, recorded ON the action so the log stays
  -- truthful after users.suspended_until moves on. An audit log records what
  -- was DONE; it must never depend on current state to explain itself.
  action_expires_at timestamptz,
  reason            text NOT NULL,
  internal_note     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX moderation_actions_post_idx     ON moderation_actions (post_id, created_at)    WHERE post_id IS NOT NULL;
CREATE INDEX moderation_actions_comment_idx  ON moderation_actions (comment_id, created_at) WHERE comment_id IS NOT NULL;
CREATE INDEX moderation_actions_subject_idx  ON moderation_actions (subject_user_id, created_at);
CREATE INDEX moderation_actions_category_idx ON moderation_actions (violation_category, created_at);

-- APPEND-ONLY, ENFORCED IN THE DATABASE. The app role has DML, so discipline
-- alone is not a guard. AC-2 requires this trigger be PROVEN to reject both an
-- UPDATE and a DELETE.
CREATE FUNCTION moderation_actions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'moderation_actions is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER moderation_actions_no_update
  BEFORE UPDATE OR DELETE ON moderation_actions
  FOR EACH ROW EXECUTE FUNCTION moderation_actions_immutable();

-- Down Migration
DROP TRIGGER IF EXISTS moderation_actions_no_update ON moderation_actions;
DROP FUNCTION IF EXISTS moderation_actions_immutable();
DROP TABLE IF EXISTS moderation_actions;
