-- Up Migration
-- Security alerting (docs/superpowers/specs/2026-10-07-security-alerting-design.md
-- §2.6 R4): an administrator's lookup of a security-alert account ref is
-- audited in the append-only moderation log. The row carries the admin's Access
-- identity and the REF (internal_note), and NEVER subject_user_id, so once the
-- ref expires (7 days) nothing links the two.
--
-- Additive: a strict superset of 0030's list (the latest; 0031-0032 did not
-- touch this constraint), so every existing row stays valid. It carries NO
-- `-- deploy: after-code` marker: it must be applied BEFORE the code that
-- writes the new kind (docs/runbooks/deploy.md, "Shipping a PR with an
-- additive migration").
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    -- Latest list, from 0030, plus this migration's addition.
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide',
    'account_hold','account_hold_release',
    'content_auto_hide',
    'security_ref_resolved'
  ));

-- Down Migration
-- Restores 0030's list. Fails while any security_ref_resolved row exists: the
-- table is append-only by trigger (0013), so such a row can never be removed,
-- and a down migration is never automated (docs/runbooks/deploy.md, Rollback).
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide',
    'account_hold','account_hold_release',
    'content_auto_hide'
  ));
