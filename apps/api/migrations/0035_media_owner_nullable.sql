-- Up Migration
-- Media ownership records on anonymisation (design:
-- docs/superpowers/specs/2026-10-16-media-ownership-records-design.md, section 3).
--
-- Anonymising an account clears `media.owner_id` on its uploads (unless the
-- object is under a per-object legal hold), so the column must admit NULL, and
-- `owner_cleared_at` records when the link was cleared. The hashes and every
-- other column stay. Additive: the FK and the `media_owner_key` index stay (a
-- NULL owner is simply not in the quota sum or in any per-owner listing).
--
-- ⚠️ APPLY THIS BEFORE THE CODE THAT WRITES NULL deploys (docs/runbooks/deploy.md).
-- With the old NOT NULL still in place the anonymisation step would fail inside
-- its own transaction and roll the account scrub back.
--
-- No backfill statement here: rows of accounts anonymised earlier are cleared
-- by the daily sweep (src/media/owner-clearing.ts), hold rule included.
ALTER TABLE media ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE media ADD COLUMN owner_cleared_at timestamptz;

-- Down Migration
-- ⚠️ REFUSES while any `media.owner_id IS NULL`: `SET NOT NULL` fails on those
-- rows, and the migration runs in one transaction, so nothing is half-applied.
-- Those rows have no owner to restore (the link was cleared on purpose), so a
-- down past this point is a data decision for a person, not an automated step.
ALTER TABLE media DROP COLUMN owner_cleared_at;
ALTER TABLE media ALTER COLUMN owner_id SET NOT NULL;
