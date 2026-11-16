-- Up Migration
-- Explicit takedown flag (M3.2d follow-up, PM ruling 2026-11-16). ADDITIVE ONLY: one nullable column, nothing existing is
-- touched, so the old code runs against it unchanged and it can be applied first.
--
-- A takedown nulls `snapshot` in place (0042), but a NULL snapshot is not itself a takedown marker, so the orphan sweep
-- cannot tell a taken-down row from any other row without a snapshot. `takedown_at` is that marker: set once by whatever
-- performs a takedown (M3.10 owns the writer; nothing sets it yet), never cleared by the sweep. The sweep
-- (references/gc.ts) keeps a flagged row forever as a content-free tombstone (evidence a takedown happened and what it
-- covered; what stops re-ingestion) and deletes every other unused row after its grace window. NULL = not taken down.
ALTER TABLE "references" ADD COLUMN takedown_at timestamptz;

-- Down Migration
-- Drops the flag and with it the record of which rows were taken down. A down migration is never automated
-- (docs/runbooks/deploy.md).
ALTER TABLE "references" DROP COLUMN IF EXISTS takedown_at;
