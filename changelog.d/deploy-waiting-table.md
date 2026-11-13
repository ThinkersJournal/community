kind: deploy runbook waiting-migrations table, pinned
---
The "Migrations waiting" table in `docs/runbooks/deploy.md` said "(none), applied through 0040" while production lacked 0041 to 0043, because the PRs for 0042 and 0043 added prose sections but no rows. The table now reads applied through 0043 (2026-11-12), and `apps/api/test/deploy-runbook.node.test.ts` fails when a migration newer than the marker has no row. Verified red-first (2 of 3 tests failed on CI before the table was fixed).
