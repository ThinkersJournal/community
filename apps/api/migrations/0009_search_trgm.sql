-- Up Migration

-- Trigram fuzzy search (M2.4a). pg_trgm ships in the postgres:18 image and is
-- Neon-allowed; it powers typo-tolerant / partial matching over posts + people.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Posts: PARTIAL expression GIN over lowercased title+body, published-only (search
-- never returns drafts). lower(...) because trigram is case-sensitive; the
-- expression (not a stored column) avoids duplicating the body. The expression here
-- MUST match the query in src/routes/search.ts byte-for-byte or it won't be used.
CREATE INDEX posts_search_trgm_idx ON posts
  USING gin (lower(title || ' ' || coalesce(markdown_source, '')) gin_trgm_ops)
  WHERE status = 'published';

-- People: PARTIAL expression GIN over lowercased username+display_name+bio,
-- onboarded-only. username is citext → cast to text for concat.
CREATE INDEX profiles_search_trgm_idx ON profiles
  USING gin (lower(coalesce(username::text, '') || ' ' || coalesce(display_name, '') || ' ' || coalesce(bio, '')) gin_trgm_ops)
  WHERE username_chosen = true;

-- Down Migration
DROP INDEX IF EXISTS profiles_search_trgm_idx;
DROP INDEX IF EXISTS posts_search_trgm_idx;
DROP EXTENSION IF EXISTS pg_trgm;
