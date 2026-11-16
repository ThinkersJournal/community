kind: M3.2d part 2: a public view wakes dormant references
---
Adds `apps/api/src/references/view-touch.ts` (`touchViewed`): a public read of a post records `last_viewed_at` on the references the post uses (throttled to one write a minute per reference) and wakes a dormant one by making `next_check_at` due now, so the next sweep tick claims it (plan decision 22). Wired into `apps/api/src/routes/public.ts` behind `REFERENCE_REFRESH`. Tested in `apps/api/test/references-view-touch.db.test.ts`.
