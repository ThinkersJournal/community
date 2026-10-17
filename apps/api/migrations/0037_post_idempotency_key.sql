-- Up Migration
-- An idempotency key on POST /posts (design: docs/superpowers/specs/
-- 2026-10-13-post-idempotency-key-design.md, section 3). The key lives ON the
-- post row, so "one post per (author, key)" is a unique index that the very
-- same INSERT statement is checked against: no transaction to add, no second
-- write that can half-fail, and the key is erased with the post for free.
--
-- ⚠️ ADDITIVE AND BACKWARDS COMPATIBLE: two nullable columns and a partial
-- index. The running code ignores them, so this is applied to production
-- BEFORE the code that uses it merges (docs/runbooks/deploy.md).
--
-- idempotency_request_sha256 is the lowercase HEX of a SHA-256 over the request
-- AS SUBMITTED (title, markdown, status, tag slugs), so a later edit to the post
-- does not make a legitimate replay look like a different request. It is hex
-- TEXT, not bytea as the design sketched: the value is only ever compared for
-- equality, and text needs no driver-specific binary handling. It is not a
-- secret and not a MAC.
--
-- ⚠️ A SECOND unique index on posts is retried as a slug collision by any code
-- that treats every unique violation alike; the create path discriminates on the
-- constraint name (posts_author_idempotency_key), see routes/posts.ts.
ALTER TABLE posts
  ADD COLUMN idempotency_key text,
  ADD COLUMN idempotency_request_sha256 text,
  ADD CONSTRAINT posts_idempotency_pair_chk CHECK (
    (idempotency_key IS NULL) = (idempotency_request_sha256 IS NULL)),
  ADD CONSTRAINT posts_idempotency_key_shape_chk CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$');

CREATE UNIQUE INDEX posts_author_idempotency_key
  ON posts (author_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS posts_author_idempotency_key;
ALTER TABLE posts
  DROP CONSTRAINT IF EXISTS posts_idempotency_key_shape_chk,
  DROP CONSTRAINT IF EXISTS posts_idempotency_pair_chk,
  DROP COLUMN IF EXISTS idempotency_request_sha256,
  DROP COLUMN IF EXISTS idempotency_key;
