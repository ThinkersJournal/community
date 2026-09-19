-- Up Migration
--
-- Author self-hide/unhide — the OTHER case in CireSnave's ruling on #26 ("an
-- author who hides their own post should still be able to fetch an image in
-- it"), stacked on #61 (community#66)'s media-visibility hook.
--
-- ⚠️ NO NEW COLUMN ON `posts` — same AC-5 discipline as decide.ts:
-- `hidden_at` is still the only column that governs visibility. "Why is it
-- hidden" (needed only to decide whether the AUTHOR may unhide it themselves)
-- is answered by the latest row in `moderation_actions` for the post, exactly
-- as decide.ts already treats that table as sole source of truth for
-- "removed, final" vs "hidden pending review". `author_hide`/`author_unhide`
-- are additive values on the SAME append-only log — not a parallel table —
-- for the same reason `media_access` joined it in 0016: one log, one truth.
--
-- ⚠️ `actor_admin` HOLDS THE AUTHOR'S OWN EMAIL HERE, DESPITE THE COLUMN NAME.
-- 0012's migration already established that column as "the acting identity,
-- or 'system' for automation" — not "an Access principal" specifically. An
-- author hiding their own content is exactly that: the acting identity, just
-- not an admin one.
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide'
  ));

-- Down Migration
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access'
  ));
