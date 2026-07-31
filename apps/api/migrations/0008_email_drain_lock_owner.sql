-- Up Migration

-- Ownership fence for the email_drain_lock lease (M2.3c). Each drain pass writes
-- an opaque per-pass token here on acquire and clears the lease only WHERE
-- leased_by matches its own token, so a pass whose lease already expired and was
-- re-acquired by a successor can never wipe the successor's live lease. Opaque
-- token, NOT the leased_until timestamp — a timestamp fence has JS Date
-- ms-truncation / cross-connection timezone-rendering footguns.
ALTER TABLE email_drain_lock ADD COLUMN leased_by text;

-- Down Migration
ALTER TABLE email_drain_lock DROP COLUMN IF EXISTS leased_by;
