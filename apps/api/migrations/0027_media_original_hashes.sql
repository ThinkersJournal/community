-- Up Migration
--
-- #114 Task 12 (CireSnave, 2026-10-08: "Yes, the site should store the hashes
-- permanently.") + the upload-scan schema (upload-scan design §4.2, §4.4, §6.6,
-- task US4). 0026 is reserved by another PR, hence 0027.
--
-- 1. The ORIGINAL upload's MD5 / SHA-1 / SHA-256, recorded at upload time.
--    POST /media re-encodes every upload to WebP and discards the original, so
--    exact-hash lists could never match our stored files. These are HASHES ONLY:
--    the original bytes are still discarded. Existing rows stay NULL — their
--    originals are gone, so there is nothing to backfill.
ALTER TABLE media
  ADD COLUMN original_md5    text CHECK (original_md5    ~ '^[0-9a-f]{32}$'),
  ADD COLUMN original_sha1   text CHECK (original_sha1   ~ '^[0-9a-f]{40}$'),
  ADD COLUMN original_sha256 text CHECK (original_sha256 ~ '^[0-9a-f]{64}$');

-- 2. The scan's own columns (design §4.2). SCHEMA ONLY: nothing writes these
--    yet, so they stay NULL until the scan is wired in. All nullable — rows from
--    before the scan have no result; pdq_source = 'stored_webp' marks a
--    backfilled row (§4.4).
ALTER TABLE media
  ADD COLUMN pdq               text     CHECK (pdq ~ '^[0-9a-f]{64}$'),   -- 256 bits, lowercase hex
  ADD COLUMN pdq_quality       smallint CHECK (pdq_quality BETWEEN 0 AND 100),
  ADD COLUMN pdq_source        text     CHECK (pdq_source IN ('original', 'stored_webp')),
  ADD COLUMN scan_path         text     CHECK (scan_path IN ('hash', 'media')),
  ADD COLUMN scan_list_version text,                                      -- the matching service's list version at the scan
  ADD COLUMN scanned_at        timestamptz;

-- Non-unique: several uploads of identical bytes share one original hash.
CREATE INDEX media_original_sha256_idx ON media (original_sha256) WHERE original_sha256 IS NOT NULL;

-- 3. The outcome record (design §6.6): a durable count of scan failures that
--    does not depend on logs. ⚠️ No user id, no hash, no classification — a row
--    says nothing about a result except through case_id, which is bare.
CREATE TABLE upload_scan_outcomes (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  at         timestamptz NOT NULL DEFAULT now(),
  outcome    text NOT NULL CHECK (outcome IN ('scanned', 'unavailable')),
  reason     text,        -- an UnavailableReason; NULL unless 'unavailable'
  scan_path  text CHECK (scan_path IN ('hash', 'media')),
  latency_ms integer,
  case_id    uuid         -- bare; set only when the scan opened or joined a case
);
CREATE INDEX upload_scan_outcomes_at ON upload_scan_outcomes (at);

-- 4. Backfill of existing media (design §4.4): a per-key status and a cursor
--    over a fixed end, so the sweep always terminates.
CREATE TABLE media_scan_backfill (                   -- one row per distinct r2_key the sweep has reached
  id          uuid NOT NULL UNIQUE DEFAULT uuidv7(), -- the alarm-mark ref for U6
  r2_key      text PRIMARY KEY,
  status      text NOT NULL CHECK (status IN ('clean', 'matched', 'unscannable', 'failed', 'needs_review')),
  attempts    smallint NOT NULL DEFAULT 0,
  next_try_at timestamptz,
  case_id     uuid,                                  -- set for 'matched': the case id only
  reviewed_by text,                                  -- 'needs_review' and 'unscannable' are closed by an admin
  reviewed_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE media_scan_backfill_progress (          -- a singleton, as 0016's media_backfill_progress is
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_id      uuid,                                 -- media.id cursor (uuidv7, ascending)
  target_id    uuid NOT NULL,                        -- max(media.id) when the sweep started: the fixed end
  completed_at timestamptz
);

-- Down Migration
-- Reverse order of the Up. Dropping the columns drops their CHECKs and the
-- partial index with them; the index is dropped explicitly first for clarity.
DROP TABLE media_scan_backfill_progress;
DROP TABLE media_scan_backfill;
DROP TABLE upload_scan_outcomes;
DROP INDEX media_original_sha256_idx;
ALTER TABLE media
  DROP COLUMN scanned_at,
  DROP COLUMN scan_list_version,
  DROP COLUMN scan_path,
  DROP COLUMN pdq_source,
  DROP COLUMN pdq_quality,
  DROP COLUMN pdq,
  DROP COLUMN original_sha256,
  DROP COLUMN original_sha1,
  DROP COLUMN original_md5;
