-- Up Migration
--
-- Issue #61: an R2 object is content-addressed and PUBLIC (`tj-media` custom
-- domain) regardless of the visibility of the post/comment that references it.
-- These tables back the fix: a private bucket for content no longer publicly
-- reachable, a durable queue for the copy/delete/purge that moves an object
-- between the two buckets (so a failed move can never silently leave content
-- public), and a per-object legal hold that is independent of any one post —
-- content-addressing means the same bytes can appear in more than one post,
-- and a legal hold must restrict the OBJECT, not just the post that triggered
-- it. See the design note on #61 for the full reasoning.

-- One row per r2_key currently under legal hold (CSAM/DMCA/etc.). Deliberately
-- keyed on the OBJECT, not a post: a hold must survive even if the triggering
-- post is later deleted, and must apply to every post/comment that happens to
-- reference the identical bytes, not only the one a moderator acted on.
-- No FK to `moderation_actions` (that table is append-only and has none of its
-- own, by the same "must outlive its subject" reasoning as 0013's header) —
-- `moderation_action_id` is a plain uuid for traceability only.
CREATE TABLE media_legal_holds (
  r2_key             text PRIMARY KEY,
  imposed_by         text NOT NULL, -- Access identity (email) of the admin who imposed it
  category           text NOT NULL CHECK (category IN ('csam', 'dmca', 'other')),
  moderation_action_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- The durable move queue. A row is inserted BEFORE the R2 copy/delete is
-- attempted (durability first — a Worker that dies mid-move leaves a row the
-- retry cron will pick up, never a move that only ever existed in memory).
-- `direction` says which way; `status` tracks progress; `attempts`/`last_error`
-- back the retry-with-alerting loop. See src/media/moves.ts.
CREATE TABLE media_moves (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  r2_key      text NOT NULL,
  direction   text NOT NULL CHECK (direction IN ('to_restricted', 'to_public')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The retry cron scans pending rows oldest-first. A key can have more than one
-- historical row (moved out, moved back), so this is NOT unique on r2_key —
-- only the newest row per key describes its current intended bucket.
CREATE INDEX media_moves_pending_idx ON media_moves (created_at) WHERE status = 'pending';
CREATE INDEX media_moves_key_idx ON media_moves (r2_key, created_at DESC);

-- Two-person authorization for a legal-hold fetch (CireSnave's ruling: "should
-- likely require multiple hands authorizing their access"). A grant is usable
-- only once approved by a SECOND distinct Access identity, within a short
-- window after approval. "Still within its window" needs `now()` and is
-- enforced only in src/moderation/media-access-requests.ts /
-- src/routes/media-restricted.ts — but "distinct from the requester" is a
-- same-row fact, so it is ALSO enforced here as a CHECK: belt-and-braces, so
-- a self-approved row cannot exist even if a future caller skips the
-- application-level guard. `lower(trim(...))` on both sides — Access emails
-- are not case-normalized upstream, so "Alice@x" approving "alice@x" must
-- still count as the SAME hand, not two.
CREATE TABLE media_access_requests (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  r2_key       text NOT NULL,
  requested_by text NOT NULL, -- Access identity (email)
  reason       text NOT NULL,
  approved_by  text,          -- Access identity (email); NULL until approved
  approved_at  timestamptz,
  expires_at   timestamptz,   -- set at approval time; NULL until approved
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_access_requests_distinct_hands
    CHECK (approved_by IS NULL OR lower(trim(approved_by)) <> lower(trim(requested_by)))
);

CREATE INDEX media_access_requests_key_idx ON media_access_requests (r2_key, created_at DESC);

-- Progress cursor for the one-off #61 backfill (src/media/backfill-hidden-media.ts).
-- A SINGLETON row (enforced by the boolean PK, which can only ever be `true`):
-- the sweep is a single global pass over content that was ALREADY hidden when
-- this shipped, not a per-something job. Runs from the `*/2 * * * *` cron
-- until `completed_at` is set (a batch smaller than the page size on BOTH
-- posts and comments means nothing remains), so exposure closes within
-- minutes of deploy rather than waiting for the once-daily retry cron.
CREATE TABLE media_backfill_progress (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_post_id     uuid,
  last_comment_id  uuid,
  completed_at     timestamptz
);
INSERT INTO media_backfill_progress DEFAULT VALUES;

-- Every privileged fetch is logged to the EXISTING append-only audit log
-- (CireSnave's ruling), not a new table. Additive CHECK swap, same pattern as
-- any other enum-widening on this append-only table.
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access'
  ));

-- Down Migration
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied'
  ));
DROP TABLE IF EXISTS media_access_requests;
DROP TABLE IF EXISTS media_backfill_progress;
DROP TABLE IF EXISTS media_moves;
DROP TABLE IF EXISTS media_legal_holds;
