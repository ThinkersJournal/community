-- Up Migration
-- Drop the legacy `users.reserved_email_sha256` column (account-legal-hold
-- spec §4a; supersedes migration 0022/0023).
--
-- 0022 stored an UNSALTED SHA-256 of a banned account's reserved email,
-- reversible by hashing candidate addresses. 0023 replaced it with the keyed
-- `reserved_email_hmac` (HMAC-SHA-256 under the `RESERVED_EMAIL_KEY` secret)
-- and kept the legacy column READ-ONLY until someone with production
-- credentials confirmed it held no rows.
--
-- The PM confirmed in production on 2026-10-03:
--   SELECT count(*) FROM users WHERE reserved_email_sha256 IS NOT NULL
-- is 0. This migration drops the column, its two CHECKs and its partial
-- index. Nothing reads or writes it any more (src/auth/reserved-email.ts
-- checks and clears only `reserved_email_hmac`).
DROP INDEX IF EXISTS users_reserved_email_sha256_idx;
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_reserved_email_only_anonymised,
  DROP CONSTRAINT IF EXISTS users_reserved_email_sha256_hex,
  DROP COLUMN IF EXISTS reserved_email_sha256;

-- Down Migration
-- Recreate exactly as 0022 had them, so the down/up round-trip is exact.
ALTER TABLE users
  ADD COLUMN reserved_email_sha256 text NULL,
  ADD CONSTRAINT users_reserved_email_sha256_hex
    CHECK (reserved_email_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT users_reserved_email_only_anonymised
    CHECK (reserved_email_sha256 IS NULL OR anonymised_at IS NOT NULL);
CREATE INDEX users_reserved_email_sha256_idx ON users (reserved_email_sha256)
  WHERE reserved_email_sha256 IS NOT NULL;
