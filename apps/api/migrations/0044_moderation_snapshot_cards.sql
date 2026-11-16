-- Up Migration
-- Self-contained evidence for reference cards (M3.2d follow-up, PM 2026-11-16). ADDITIVE ONLY: one nullable column on
-- `moderation_snapshots` (0021), nothing existing is touched. That table's guard refuses UPDATE and early DELETE of ROWS;
-- adding a column is DDL and does not touch it.
--
-- `card_snapshots` is the card metadata of the references a post used, copied in the same statement that snapshots the
-- post (routes/posts.ts handleDeletePost): a jsonb array of {token, kind, resource_key, content_hash, position, snapshot},
-- the `snapshot` being the whole stored card (title, description, image URL...). It makes the evidence copy independent
-- of the shared `"references"` row, which the orphan sweep (references/gc.ts) may collect after a year. NULL = no cards
-- (an older snapshot, or a post with none). BARE data, no foreign key: the evidence must outlive the reference.
ALTER TABLE moderation_snapshots ADD COLUMN card_snapshots jsonb;

-- Down Migration
-- Drops the copied card metadata. A down migration is never automated (docs/runbooks/deploy.md).
ALTER TABLE moderation_snapshots DROP COLUMN IF EXISTS card_snapshots;
