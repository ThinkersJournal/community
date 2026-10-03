-- Up Migration
-- A banned account's email reservation becomes a KEYED fingerprint
-- (account-legal-hold spec §4a, as amended 2026-10-02).
--
-- 0022 stored `reserved_email_sha256`, an UNSALTED SHA-256 of the normalised
-- address. Anyone holding that column can recover the address by hashing
-- candidate addresses and comparing. This column holds
-- HMAC-SHA-256(RESERVED_EMAIL_KEY, normalizeEmail(email)) instead, as
-- lowercase hex (src/auth/reserved-email.ts). Without the key, which lives
-- only as a Workers secret, a guessed address can't be tested against it.
--
-- ⚠️ THE LEGACY COLUMN STAYS, READ-ONLY. Nothing writes `reserved_email_sha256`
-- any more, but signup still checks it (a row 0022's reaper wrote must stay
-- reserved) and `releaseReservedEmail` still clears it. It is NOT dropped
-- here: an HMAC can't be computed from a SHA-256, so a drop would silently
-- release any address it reserves. A later migration drops it once someone
-- with production credentials confirms
--   SELECT count(*) FROM users WHERE reserved_email_sha256 IS NOT NULL
-- is 0.
--
-- Same two CHECKs as 0022's column, and the same NON-unique partial index
-- (spec §4a says why it is not unique).
ALTER TABLE users
  ADD COLUMN reserved_email_hmac text NULL,
  ADD CONSTRAINT users_reserved_email_hmac_hex
    CHECK (reserved_email_hmac ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT users_reserved_email_hmac_only_anonymised
    CHECK (reserved_email_hmac IS NULL OR anonymised_at IS NOT NULL);
CREATE INDEX users_reserved_email_hmac_idx ON users (reserved_email_hmac)
  WHERE reserved_email_hmac IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS users_reserved_email_hmac_idx;
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_reserved_email_hmac_only_anonymised,
  DROP CONSTRAINT IF EXISTS users_reserved_email_hmac_hex,
  DROP COLUMN IF EXISTS reserved_email_hmac;
