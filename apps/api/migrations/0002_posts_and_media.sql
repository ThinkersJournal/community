-- Up Migration
--
-- ⚠️ REQUIRES POSTGRES 18 — `uuidv7()` is a native builtin added in 18 and does
-- not exist before it. See docker-compose.yml and test/postgres-version.db.test.ts.
--
-- ⚠️ UUIDv7 HERE, v4 IN users/profiles — DELIBERATE, AND PER TABLE. FKs are
-- plain uuid comparisons with no version semantics, so mixing across tables is
-- a non-issue. v7 is used ONLY where we keyset-paginate (posts, media; comments
-- in M2). users/profiles are PK-lookup and low-volume: v7 locality buys nothing
-- there, and rewriting their PKs would mean rewriting every FK reference.
--
-- ⚠️ A v7 id LEAKS ITS ROW'S CREATION TIME to anyone holding it. Accepted here
-- (posts and media are public artifacts and we display their dates anyway).
-- NEVER put a v7 PK on a table where creation time is sensitive.

CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  -- citext: slugs are matched from a URL, which is case-carrying. Case-folding
  -- here is what stops `/@me/Post` and `/@me/post` being two rows (two cache
  -- entries, two canonical URLs, one duplicate-content penalty).
  slug citext NOT NULL,
  -- THE SINGLE SOURCE OF TRUTH. Clean Markdown, rendered at READ time (see
  -- packages/markdown). No rendered HTML is ever stored: that is what makes a
  -- sanitizer fix a DEPLOY rather than a backfill of every row, and it is what
  -- M3's live ref-cards require. `{{ref:TOKEN}}` placeholders land here in M3.
  markdown_source text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  published_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT posts_status_check CHECK (status IN ('draft', 'published')),
  -- A published post ALWAYS has a publication time. Enforced here rather than
  -- in the handler because the transaction-mode pooler means the database is
  -- the only place an invariant cannot be raced around.
  CONSTRAINT posts_published_has_timestamp
    CHECK (status <> 'published' OR published_at IS NOT NULL)
);

-- The public URL `/@username/slug` must resolve to exactly one row.
CREATE UNIQUE INDEX posts_author_slug_key ON posts (author_id, slug);

-- KEYSET PAGINATION. v7 ids are time-ordered, so `ORDER BY id DESC` IS
-- newest-first and NO created_at index is needed — that is the whole payoff.
--   SELECT ... WHERE author_id = $1 AND status = 'published' AND id < $2
--   ORDER BY id DESC LIMIT 20;   -- $2 = last-seen id; page 1 uses the all-f UUID
-- Partial: drafts are never in a public listing, so they do not belong in the
-- index that serves one.
CREATE INDEX posts_author_published_key ON posts (author_id, id DESC)
  WHERE status = 'published';

-- Site-wide newest-first, for sitemap.xml + rss.xml.
CREATE INDEX posts_published_key ON posts (id DESC) WHERE status = 'published';

CREATE TABLE media (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The R2 object key, CONTENT-ADDRESSED on the TRANSFORMED output:
  -- `media/<variant>/<sha256>.webp`. Deliberately NOT unique, and deliberately
  -- WITHOUT the user id in it.
  --
  -- ⚠️ DEDUPE/DELETION HAZARD — DESIGNED FOR, NOT DISCOVERED LATER. Two users
  -- uploading the same image share ONE R2 object with TWO rows. Deleting A's
  -- row MUST NOT delete the object while B still references it. M1 therefore
  -- NEVER deletes an R2 object inline; reclamation is an offline GC that drops
  -- objects with no remaining `media` row (M4, alongside moderation deletion).
  r2_key text NOT NULL,
  -- Hex SHA-256 of the TRANSFORMED (WebP) bytes — the same value embedded in
  -- r2_key. Stored separately so an upload of an already-known image can be
  -- answered without an R2 round-trip.
  sha256 text NOT NULL,
  -- Of the stored WebP, not the discarded original. This column is the quota.
  bytes bigint NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Serves both the per-user quota sum and a future "my uploads" keyset listing.
CREATE INDEX media_owner_key ON media (owner_id, id DESC);
CREATE INDEX media_sha256_key ON media (sha256);

-- Down Migration
-- media first is not required (no FK between them), but keep the mirror order.
DROP TABLE IF EXISTS media;
DROP TABLE IF EXISTS posts;
