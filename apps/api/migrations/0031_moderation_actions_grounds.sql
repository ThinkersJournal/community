-- Up Migration
-- #57 (DSA Art. 17), PR-C: the two GROUNDS a content decision may cite, as
-- structured, optional columns on the append-only moderation audit log.
--   legal_ground       - the decision rests on the content being illegal
--   contractual_ground - the decision rests on a Terms / Community Guidelines clause
-- Independent and nullable: one decision can be both illegal and a terms
-- violation, and neither is required (a required field would break the form).
--
-- ⚠️ The value lists are PROPOSED, pending attorney / CireSnave review (see
-- docs/superpowers/specs/2026-10-14-art17-ground-enums.md). They mirror
-- LEGAL_GROUNDS / CONTRACTUAL_GROUNDS in packages/shared/src/admin.ts; widening
-- a list is a CHECK change, not a data change.
--
-- ⚠️ NO BACKFILL, NO UPDATE. `moderation_actions` is append-only (0013's trigger
-- refuses UPDATE and DELETE), so earlier rows keep NULL: "not recorded" is the
-- true answer for them. ADD COLUMN of a nullable column rewrites no row.
ALTER TABLE moderation_actions
  ADD COLUMN legal_ground text
    CONSTRAINT moderation_actions_legal_ground_valid
    CHECK (legal_ground IN ('csam','copyright_infringement','illegal_content_other')),
  ADD COLUMN contractual_ground text
    CONSTRAINT moderation_actions_contractual_ground_valid
    CHECK (contractual_ground IN (
      'guidelines_threats_harassment','guidelines_hate_speech','guidelines_ncii',
      'guidelines_doxxing','guidelines_spam','guidelines_malware_phishing',
      'guidelines_impersonation','guidelines_ip','terms_other'));

-- Down Migration
ALTER TABLE moderation_actions
  DROP COLUMN IF EXISTS contractual_ground,
  DROP COLUMN IF EXISTS legal_ground;
