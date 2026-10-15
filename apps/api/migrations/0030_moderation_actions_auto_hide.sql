-- Up Migration
-- DSA Art. 17 / #57 (CireSnave Q4=B): an AUTO-HIDE appends a `moderation_actions`
-- row with actor 'system', so the statement of reasons can say the hide was
-- automated. ONE new kind, `content_auto_hide`.
--
-- ⚠️ IT IS AN AUDIT FACT, NOT A RULING. It is not in the 0013 "handled" sense
-- (queue.ts), not appealable (APPEALABLE_ACTIONS), and not a visibility action
-- (visibility-actions.ts): every reader that used `action LIKE 'content\_%'`
-- now filters to the explicit human-ruling list instead.
--
-- Nothing else changes: `actor_admin` is already free text documented as "the
-- acting identity, or 'system' for automation" (0013) with no CHECK, and
-- `reason` is NOT NULL, so the row carries the constant reason
-- AUTO_HIDE_ACTION_REASON (auto-hide.ts) — never reporter identity or count.
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    -- Latest list, from 0022, plus this migration's addition.
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide',
    'account_hold','account_hold_release',
    'content_auto_hide'
  ));

-- Down Migration
-- ⚠️ Refuses (the ADD CONSTRAINT validates every row) while any
-- `content_auto_hide` row exists: the log is append-only (0013's trigger), so
-- those rows cannot be deleted. A down migration past this point is a data
-- decision, not a mechanical step.
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide',
    'account_hold','account_hold_release'
  ));
