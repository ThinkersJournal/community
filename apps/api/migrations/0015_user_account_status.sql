-- Up Migration
-- ACCOUNT STATUS (issue #35). Until now `users` had five columns and none of
-- them could express "this account is barred".
--
-- ⚠️ THE security_epoch KILLS EXISTING SESSIONS AND DOES NOTHING ABOUT NEW
-- ONES. A banned user re-authenticated, received a fresh session carrying the
-- CURRENT epoch, and the comparison passed. The ban survived exactly until the
-- next login. These columns are the other half.
--
-- ⚠️ SOFT-DISABLE ONLY, NEVER A ROW DELETE. The row and its content are
-- evidence -- for appeals, for DSA statements of reasons, and for the CSAM
-- preservation path that shares this primitive.
ALTER TABLE users ADD COLUMN suspended_until timestamptz;
ALTER TABLE users ADD COLUMN disabled_at     timestamptz;
ALTER TABLE users ADD COLUMN disabled_reason text;

-- The login lookup is by email and already indexed; these columns are read
-- from the row it finds, so they need no index of their own. The reaper's
-- predicate gains two IS NULL terms on a batch job that runs daily.

-- Down Migration
ALTER TABLE users DROP COLUMN IF EXISTS disabled_reason;
ALTER TABLE users DROP COLUMN IF EXISTS disabled_at;
ALTER TABLE users DROP COLUMN IF EXISTS suspended_until;
