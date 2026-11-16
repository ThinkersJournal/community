kind: NEW MIGRATION 0044 `references.takedown_at`: an explicit takedown flag for the orphan sweep
---
Adds `apps/api/migrations/0044_references_takedown_flag.sql` (`"references".takedown_at timestamptz`, nullable, additive). `apps/api/src/references/gc.ts` keeps only flagged rows as tombstones; a row whose `snapshot` is NULL but is not flagged is an ordinary orphan and is deleted after the grace window. Nothing sets the flag yet (M3.10 owns the takedown writer). Tombstone retention is board 452. Tested in `apps/api/test/references-gc.db.test.ts`.
