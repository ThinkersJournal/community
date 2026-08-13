-- Up Migration
-- Handle selection moved to signup (docs/superpowers/specs/2026-08-13-handle-at-signup-design.md),
-- so the onboarding flag is obsolete. The search partial index predicated on it must be
-- rebuilt without the predicate before the column can be dropped.
DROP INDEX IF EXISTS profiles_search_trgm_idx;
ALTER TABLE profiles DROP COLUMN username_chosen;
CREATE INDEX profiles_search_trgm_idx ON profiles
  USING gin (lower(coalesce(username::text, '') || ' ' || coalesce(display_name, '') || ' ' || coalesce(bio, '')) gin_trgm_ops);

-- Down Migration
DROP INDEX IF EXISTS profiles_search_trgm_idx;
ALTER TABLE profiles ADD COLUMN username_chosen boolean NOT NULL DEFAULT false;
CREATE INDEX profiles_search_trgm_idx ON profiles
  USING gin (lower(coalesce(username::text, '') || ' ' || coalesce(display_name, '') || ' ' || coalesce(bio, '')) gin_trgm_ops)
  WHERE username_chosen = true;
