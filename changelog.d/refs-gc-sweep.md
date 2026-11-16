kind: M3.2d orphan-reference garbage collection
---
Adds `apps/api/src/references/gc.ts` (`gcOrphanReferences`): deletes `"references"` rows that no `post_references` row uses, once older than 24 h by the later of `created_at` and `updated_at`, at most 500 per run, `FOR UPDATE SKIP LOCKED`. Runs from `apps/api/src/references/refresh-wiring.ts` (`gcReferencesDaily`) on the existing `15 4 * * *` cron, dark unless `REFERENCE_REFRESH` is "1". No migration, no wrangler change. Tested in `apps/api/test/references-gc.db.test.ts`.
