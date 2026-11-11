-- Up Migration
-- The reference store (M3.1b; spec docs/superpowers/specs/2026-11-09-m3-connector-contract.md section 4). ADDITIVE ONLY:
-- two new tables, nothing existing is touched, so the old code runs against it unchanged and it can be applied first.
--
-- `references` is a reserved word in Postgres: it is double-quoted here and in every query.
--
-- A `"references"` row is one resolved external resource, shared by every post that uses it (public dedupe by
-- (kind, resource_key, content_hash)). A `post_references` row is one post's USE of it and carries the token the
-- author writes as {{ref:TOKEN}} in the post's markdown.
--
-- Public-only at launch (spec 3.4): visibility is CHECKed to 'public'. M3.5 (private resources) relaxes that CHECK by
-- a migration and starts using owner_connection_id (always NULL now). `kind` is a text column with a CHECK list that
-- later connectors extend by migration.
--
-- `snapshot` is NULLABLE on purpose: a takedown must be able to null it in place (spec 4, DMCA), and a null snapshot
-- renders the "no longer available" card. The contract table says NOT NULL; the next sentence of the same section
-- needs it nullable, and the safe reading is the one that lets a snapshot be removed.
--
-- GRANTS: none here. The least-privilege role (docs/superpowers/specs/2026-09-02-least-privilege-db-role-design.md 3.4)
-- gets DML on every table a migration creates through ALTER DEFAULT PRIVILEGES, which is why no earlier migration
-- (0040 included) grants anything either.
CREATE TABLE "references" (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  kind                text        NOT NULL,
  resource_key        text        NOT NULL,
  visibility          text        NOT NULL DEFAULT 'public',
  owner_connection_id uuid,
  content_hash        text        NOT NULL,
  snapshot            jsonb,
  live_state          jsonb,      -- {access, diff, observedAt, snapshot?}; written by the M3.2 refresh sweep
  etag                text,
  last_modified       text,
  retention_policy    text        NOT NULL DEFAULT 'none',
  last_viewed_at      timestamptz,
  next_check_at       timestamptz, -- NULL = dormant (M3.2 fills these in)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  gone_at             timestamptz,
  CONSTRAINT references_kind_valid CHECK (kind IN ('web','github','gitlab')),
  CONSTRAINT references_visibility_public CHECK (visibility = 'public'),
  CONSTRAINT references_dedupe_key UNIQUE (kind, resource_key, content_hash)
);

CREATE TABLE post_references (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  post_id      uuid        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  reference_id uuid        NOT NULL REFERENCES "references"(id),
  token        text        NOT NULL,
  position     int         NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_references_post_token_key UNIQUE (post_id, token),
  -- 12 characters of unpadded base32 (spec section 2).
  CONSTRAINT post_references_token_format CHECK (token ~ '^[A-Z2-7]{12}$')
);
-- Which posts use a reference (the M3.2 sweep's garbage collection, and the DELETE guard on "references").
CREATE INDEX post_references_reference_idx ON post_references (reference_id);

-- Down Migration
-- Drops both tables, and with them every stored snapshot and use. A down migration is never automated
-- (docs/runbooks/deploy.md).
DROP TABLE IF EXISTS post_references;
DROP TABLE IF EXISTS "references";
