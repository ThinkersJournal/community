-- #57 (DSA Art. 17 statement of reasons), PR-A: three columns on the append-only
-- moderation audit log, so each content decision records WHAT prompted it and
-- WHERE it applies. All additive and nullable (or defaulted).
--
-- ⚠️ NO BACKFILL, NO UPDATE. `moderation_actions` is append-only (0013's trigger
-- refuses UPDATE and DELETE), so rows written before this migration keep NULL in
-- `source` and `dsa_notice_id`: "not recorded" is the true answer for them.
-- ADD COLUMN with a constant default rewrites no row and fires no row trigger.
--
-- ⚠️ NO FOREIGN KEY on `dsa_notice_id`, matching 0013's deliberate stance: a
-- referential action on this table would be an UPDATE the trigger refuses, and
-- the log must outlive its subjects. The link is also held from the other side
-- (`dsa_notices.resolution_action_id`); this column makes the action row
-- self-describing.
ALTER TABLE moderation_actions
  -- What prompted the decision: a confirmed DSA notice, a member report, or the
  -- moderator's own initiative. Written only for content_restore /
  -- content_keep_hidden / content_remove; NULL on every other kind of row.
  ADD COLUMN source text
    CONSTRAINT moderation_actions_source_valid
    CHECK (source IN ('dsa_notice','member_report','own_initiative')),
  -- The notice this decision answered, when `source = 'dsa_notice'`. If a
  -- decision resolved several notices, the one with the lowest created_at.
  ADD COLUMN dsa_notice_id uuid,
  -- Where the restriction applies. Every restriction today is global (hidden_at
  -- hides the content everywhere), so rows that existed before this column get
  -- 'global' from the default and that is TRUE of them. Nothing enforces any
  -- narrower scope; the list is deliberately a single value until geo-blocking
  -- exists, and widening it is a CHECK change, not a data change.
  ADD COLUMN territorial_scope text NOT NULL DEFAULT 'global'
    CONSTRAINT moderation_actions_territorial_scope_valid
    CHECK (territorial_scope IN ('global')),
  -- A notice id only makes sense when the source says a notice prompted it.
  ADD CONSTRAINT moderation_actions_notice_needs_source
    CHECK (dsa_notice_id IS NULL OR source = 'dsa_notice');

-- Down Migration
ALTER TABLE moderation_actions
  DROP CONSTRAINT IF EXISTS moderation_actions_notice_needs_source,
  DROP COLUMN IF EXISTS territorial_scope,
  DROP COLUMN IF EXISTS dsa_notice_id,
  DROP COLUMN IF EXISTS source;
