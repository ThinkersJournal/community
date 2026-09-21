-- Up Migration
--
-- #70 password reset: a single-use, expiring, server-side token.
--
-- ⚠️ NOT THE SESSIONS KV NAMESPACE. src/auth/email-verify.ts's own header
-- warns that its peek/delete pair is a non-atomic race, safe there only
-- because a double-redeem is harmless (email verification's UPDATE is an
-- idempotent restamp). A password reset GRANTS something on redemption, so
-- it needs a REAL atomic compare-and-set: `UPDATE ... WHERE used_at IS NULL
-- AND expires_at > now() RETURNING user_id` (src/auth/password-reset.ts),
-- which KV cannot provide.
--
-- Only the SHA-256 hash of the token is ever stored — same discipline as
-- sessions (auth/session.ts) and verification tokens (auth/email-verify.ts)
-- — so a leaked/dumped table row never reveals a usable reset link.
--
-- ⚠️ `ON DELETE CASCADE`, unlike moderation_actions' deliberate no-FK
-- append-only design: this table has no audit purpose once a user is gone —
-- an orphaned reset token for a deleted account can never be redeemed
-- (nothing to reset), so there is no reason to keep the row.
CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  -- NULL = still redeemable. Set exactly once, by the atomic UPDATE that
  -- consumes it — never by any other statement.
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id, created_at);

-- Down Migration
DROP TABLE IF EXISTS password_reset_tokens;
