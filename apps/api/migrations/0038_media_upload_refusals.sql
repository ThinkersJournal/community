-- Up Migration
-- Issue #148: a refused upload of restricted bytes is EVIDENCE (for CSAM-held
-- content the attempt is exactly what a case file wants), and until now it was
-- only a console.warn line, which Workers logs do not keep. One row per
-- refusal: which object, who tried, and why it was refused.
--
-- ⚠️ ADDITIVE: a new table nothing else reads. Applied to production BEFORE the
-- code that writes it merges (docs/runbooks/deploy.md).
--
-- No FK to users or media_legal_holds, by the same reasoning as 0016's holds:
-- the record must outlive the account and the hold. `uploader_id` is a plain
-- uuid for traceability only.
CREATE TABLE media_upload_refusals (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  r2_key      text NOT NULL,
  uploader_id uuid NOT NULL,
  reason      text NOT NULL CHECK (reason IN (
    'legal_hold',              -- the key was already under a hold at the pre-put check
    'hold_imposed_in_flight',  -- a hold committed between the pre-put check and the row write
    'restricted_unreachable'   -- hidden (no hold), in the restricted bucket, no visible post references it
  )),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX media_upload_refusals_key_idx ON media_upload_refusals (r2_key, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS media_upload_refusals;
