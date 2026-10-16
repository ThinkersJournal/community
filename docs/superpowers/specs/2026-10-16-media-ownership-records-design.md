# Media ownership records on anonymisation — design (for PM review)

Status: DESIGN ONLY, no code. Source: the ROADMAP row "clear `media.owner_id` on anonymisation, keep
hashes, hold-aware". The earlier "plan approved, T1-T10" could not be found in git or any ledger and is not
relied on. Facts below are read at `origin/main` 03f0c73 (0.1.50).

## 1. Problem
`media.owner_id` is `uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE` (0002). Account anonymisation
(`auth/anonymise-accounts.ts`) is an in-place `UPDATE` of `users`/`profiles`, never a `DELETE`, and does not
touch `media`. So after anonymisation every upload row still names the (scrubbed) user id: a stable
pseudonymous key that links all of that person's uploads, their upload times and sizes, and (0027) the
original-upload hashes. The cascade never fires, because nothing deletes the `users` row.

## 2. Rule
On anonymisation, `media.owner_id` is cleared **unless the object is held**. The hashes stay.
- Kept always: `r2_key`, `sha256`, `original_md5/sha1/sha256` (CireSnave, #114 Task 12: "the site should store
  the hashes permanently"), `pdq*`, scan columns, `created_at`, `bytes`, `width`, `height`.
- Cleared: `owner_id`; stamped `owner_cleared_at timestamptz`.
- **Hold-aware.** A row is NOT cleared while a per-object hold exists on its `r2_key`
  (`media_legal_holds`, 0016) or while it is evidence for a case (to confirm in implementation: the CSAM
  case tables, if present on `main`, and `moderation_snapshots`). Reason: the owner link may be the evidence.
  An account with an active `account_legal_holds` row is never anonymised at all (existing gate), so this
  only concerns a per-object hold on an otherwise-anonymisable account.

## 3. Migration `0035_media_owner_nullable.sql` (next free after outbox 0034; PM applies it before merge)
```sql
-- Up
ALTER TABLE media ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE media ADD COLUMN owner_cleared_at timestamptz;
-- Down (refuses while any owner_id IS NULL; a down past this point is a data decision)
ALTER TABLE media DROP COLUMN owner_cleared_at;
ALTER TABLE media ALTER COLUMN owner_id SET NOT NULL;
```
Additive; the FK and `media_owner_key` index stay (a NULL is simply not in the quota sum or "my uploads").
Must be applied BEFORE the code, which writes NULL. No backfill statement in the migration (see 4).

## 4. Code
1. `anonymiseOne`: in the same transaction, after the guarded `users` UPDATE reports `changed`:
   `UPDATE media SET owner_id = NULL, owner_cleared_at = now() WHERE owner_id = $1 AND NOT EXISTS
   (SELECT 1 FROM media_legal_holds h WHERE h.r2_key = media.r2_key)`.
2. A bounded, idempotent sweep step in the same daily run clears rows still owned by an ALREADY-anonymised
   user (`users.anonymised_at IS NOT NULL`). This is the backfill for accounts anonymised before the change AND the
   catch-up after a per-object hold is released. Batch cap like `REAP_BATCH`; count logged; no ids in logs.
3. Readers of `owner_id`: `routes/media.ts` quota sum and the insert only. A NULL owner is never an uploader
   again (the account is anonymised), so quota is unaffected. Re-check at implementation with a grep.
4. Moderation reads that join `media` to a user (admin media access, holds) must tolerate NULL: list them in
   the implementation PR and add a test per reader.

## 5. Tests (each with its control)
- Anonymise clears the owner of an ordinary row and keeps every hash column byte-for-byte.
- A row on a held `r2_key` keeps its owner; after the hold is released, the sweep clears it.
- An account under an active account hold is not anonymised, so its media keep their owner.
- The sweep clears rows of an already-anonymised user (backfill) and is a no-op on the second run.
- A second user's row on the SAME `r2_key` (dedupe) is cleared/kept independently per row.
- Migration up/down/up round trip; the down refuses while a NULL owner exists.

## 6. Open questions (CireSnave / attorney, not decided here)
1. May the owner link be kept for HELD objects after the account is anonymised? This design says yes (evidence),
   pending a legal view (GDPR Art. 17(3)(b)/(e); 18 U.S.C. 2258A preservation).
2. Do the `media` rows of a never-anonymised, banned account matter here? Out of scope: only anonymisation clears.
3. `moderation_snapshots` / case tables may carry the owner independently of `media`; whether they need the same
   treatment is a separate review.

## 7. Build
One implementation PR (migration 0035 + `anonymiseOne` step + sweep + tests), a version at gate, the PM applies
0035 first. Nothing else depends on it.
