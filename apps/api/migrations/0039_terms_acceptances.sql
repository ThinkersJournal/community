-- Up Migration
-- S6 / ROADMAP R10 (CireSnave, 2026-10-25): signup records that the person ticked
-- "I am 16 or over and agree to the Terms, Guidelines and Privacy Policy". One row
-- per (account, text version): a later material change of the text (S27) records a
-- second row rather than overwriting the first, so what was agreed and when stays
-- provable.
--
-- `terms_version` is stamped by the server (packages/shared TERMS_VERSION), never
-- taken from the client. `minimum_age` is the age attested at the time (16 today),
-- stored so changing the constant later does not rewrite history.
--
-- Deleted with the account (ON DELETE CASCADE): the record exists to answer "did
-- this account agree?", and an anonymised account keeps its users row, so its
-- record stays; a hard-deleted account has no one left to dispute.
--
-- ⚠️ Applied to production BEFORE the code that writes it merges
-- (docs/runbooks/deploy.md): the new signup writes this row inside its
-- transaction, so deploying it against a database without 0039 fails every signup.
-- Accounts created before this migration have no row (nothing recorded their
-- agreement; the Terms text at the time said account creation was agreement).
CREATE TABLE terms_acceptances (
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version text        NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 40),
  minimum_age   smallint    NOT NULL CHECK (minimum_age BETWEEN 13 AND 21),
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, terms_version)
);

-- Down Migration
DROP TABLE IF EXISTS terms_acceptances;
