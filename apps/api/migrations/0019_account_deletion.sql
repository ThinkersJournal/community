-- Up Migration
--
-- Account deletion (board item 59 = Option C): CireSnave ruled anonymise (not
-- hard-delete) with a 30-day grace period, handle released after it expires.
--
-- ⚠️ NOT a `DELETE FROM users`. Every content/relationship table
-- (posts.author_id, comments.author_id, follows.*, reactions.user_id,
-- notifications.*, notification_prefs.user_id, blocks.*, reports.reporter_id,
-- password_reset_tokens.user_id) is `ON DELETE CASCADE` against users(id) —
-- see 0001_users_and_profiles.sql and the tables that followed it. A real
-- delete would destroy every post/comment/reaction the account ever made,
-- which contradicts "keep posts". The deletion flow is therefore two
-- in-place UPDATEs on this column pair, never a DELETE FROM users:
--
--   1. request  (src/routes/account.ts's handleRequestDeletion):
--        deletion_requested_at = now()
--      Account stays FULLY USABLE during the 30 days — CireSnave's grace
--      period must be exercisable, and an unlockable "pending deletion"
--      state would let anyone with a live session lock the real owner out
--      for 30 days as a denial-of-service. A cancel endpoint
--      (handleCancelDeletion) clears the column back to NULL.
--
--   2. scrub    (src/auth/anonymise-accounts.ts, a daily cron, same shape as
--      reap-unverified.ts/reap-orphan-media.ts): once
--      `deletion_requested_at < now() - 30 days` and `anonymised_at IS NULL`,
--      scrubs email/password_hash/display_name/bio/username in place and
--      sets anonymised_at. See that file for the exact sentinel values and
--      why each is chosen.
ALTER TABLE users
  ADD COLUMN deletion_requested_at timestamptz NULL,
  ADD COLUMN anonymised_at timestamptz NULL;

-- Down Migration
ALTER TABLE users
  DROP COLUMN deletion_requested_at,
  DROP COLUMN anonymised_at;
