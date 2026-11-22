# Changelog

All five workspace packages carry one version number. The log starts at 0.1.68; earlier history is in `git log`
(subjects name the PR). Pre-1.0, a breaking change moves the second number.

## 0.1.157 — docs: record the Q7 workerd spike evidence in ROADMAP S21

Records, in `docs/ROADMAP.md` row S21, what the 2026-10-10 local `wrangler dev` spike of the pdq `.wasm` showed: a 512x512 `si_pdq_dihedral` loop returned 200 with rising latency (up to 10268ms) and then the workerd runtime crashed twice. The cause is undiagnosed, so the CPU and memory fit stays UNPROVEN and Q7 must be re-run on the published crate. Also adds `docs/ROADMAP.md` row R13 (legal text 468: wording on main, serving waits on the #114 passages and `REFERENCE_REFRESH=1`) and replaces two "attorney" phrasings in rows R9 and S7, since there is no attorney. Documentation only; no code or behaviour change.

## 0.1.156 — M3.10 hardening slices: removed posts keep their card evidence, egress logging, concurrency tests

A post removed by a moderator (or by a DMCA takedown, which runs the same decision code) now copies its reference cards into `moderation_snapshots.card_snapshots` in the same transaction, as the author-delete path already did; the shared subselect lives in `apps/api/src/references/card-snapshots.ts`. Every outbound reference fetch logs one `ref_fetch` JSON line (host, outcome, bytes, durationMs; never the URL, path, query or card text) in `apps/api/src/references/guarded-fetch.ts`, and every refresh one `ref_refresh` line in `apps/api/src/references/refresh.ts`; the logging adds no behavioural change to the authenticated-API path. New tests: `apps/api/test/references-moderated-hidden.test.ts` (moderator remove, keep_hidden and DMCA takedown give a public 404 with no `refs` or card text), `apps/api/test/references-moderation-card-snapshots.test.ts`, `apps/api/test/references-fetch-log.test.ts`, and concurrency tests for `claimDueRefreshes` and the per-author budget. `README.md` gains an alert-checklist row for `ref_fetch` (thresholds and destination TBD by the PM) and `docs/PATENT-SWEEP.md` an "M3 live references" section of candidate ideas, all marked NOT YET SEARCHED. DRAFT legal text (not in force, wording for CireSnave sign-off): a "Links you attach" paragraph and a reference-snapshot retention bullet in `docs/legal/privacy-policy.md`, and a rewritten section 6 in `docs/legal/terms-of-service.md`; the `[[NOT YET TRUE]]` passage on issue 114 is untouched and the PR that serves the page must remove it first. Not run here: no `node_modules` in this worktree, so none of the tests or the typecheck have been executed.

## 0.1.155 — Reference-change notifications (M3.9, NEW MIGRATION 0045), dark behind REFERENCE_REFRESH

**M3.9.** When a reference refresh finds a linked page gone or changed, the authors of the published, non-hidden posts that use it get a bell notification (`apps/api/src/references/refresh.ts`, written through the one seam `notifyReferenceChange` in `apps/api/src/notifications/create.ts`). `gone` and `changed` notify; `resolved` and `unknown` never do; a reference's first look (no stored `live_state`) never does. One notification per (author, post); a `changed` notice is keyed on the new content hash, so the same state notifies once ever and a genuinely new one notifies again. Drafts, hidden (moderated) and removed posts notify nobody. At most 20 reference notifications per author per rolling day; extras are dropped. The notification carries fixed text plus the author's own post title and never any snapshot text from the linked page. It rides the existing `reactions` email channel (default digest). Ships dark: nothing refreshes until `REFERENCE_REFRESH` is "1".

**NEW MIGRATION `apps/api/migrations/0045_reference_change_notifications.sql`** (apply before deploy; row added to `docs/runbooks/deploy.md`): `notifications.actor_id` becomes nullable, `kind` gains `reference_changed`, new `reference_id` and `reference_event` columns, the unique key is re-added to include them, plus a shape CHECK. The table is pre-launch, so the drop-and-add is cheap. Pinned by `apps/api/test/references-notify.db.test.ts` and `apps/api/test/notifications-schema.db.test.ts`.

## 0.1.154 — Paste-to-enrich in the post editor (M3.4c), M3.9 design note, ROADMAP R11 notes

**M3.4c.** Pasting a bare http(s) link into the Markdown editor of a saved post fills the link-card box (`apps/web/src/scripts/reference-picker.ts`) and offers a card in the status line; the paste itself is never altered. If the author presses Add card, the URL's own line becomes the `{{ref:TOKEN}}` marker (`replaceUrlLineWithRef` in `apps/web/src/scripts/paste-enrich.ts`); if that line was edited meanwhile, the marker is inserted at the cursor as before. Prose, several links and non-http(s) schemes are ignored. Pinned by `apps/web/test/paste-enrich.test.ts`.

**M3.9 design note.** Adds `docs/superpowers/specs/2026-11-19-m3-9-reference-change-notifications.md`, a design only (no code, no migration), ruled by pm-web on 2026-11-19: who is told, for which diff states, the `notifications` shape, the channel and a per-author cap.

**ROADMAP R11.** Records that M3.4c is built, that M3.6 GitLab is not built (ruled A2 on 2026-11-19: gitlab.com's robots.txt disallows `/api/v*`, so GitLab URLs stay generic web unfurls), and that Dependabot's TypeScript 7 bump is deferred because `astro check` rejects it.

## 0.1.153 — Dependabot npm-weekly group (#318, #320) folded, TypeScript held at 6.0.3

Folds the grouped npm-weekly bumps from the Dependabot PRs (@playwright/test 1.65.1, @types/node 26.6.6, @cloudflare/vitest-plugin 1.8.2, vitest 5.1.0, wrangler 4.162.0, @astrojs/cloudflare 14.4.8, astro 7.4.12, fast-xml-parser 5.12.1, shiki 4.6.0, unist-util-visit 5.2.0) into one change. TypeScript stays at 6.0.3 (an override in package.json pins it) because `astro check` in apps/web refuses TypeScript 7 (verified in the Dependabot run log: "astro check does not currently support TypeScript 7.0"). `@emnapi/runtime` is pinned to 1.11.1 because a fresh resolve picked 2.0.0-beta.2, which crashes `astro check` (`this.bridge.setLastError is not a function`). Verified locally: `pnpm -r typecheck` clean; packages/shared and packages/markdown tests pass; apps/api tests need the CI database.

## 0.1.152 — M3.4b author-side "Insert a link card" control in the post editor

The post editor now has an "Insert a link card" control (edit mode only: a card needs a saved post, so create mode shows "Save a draft first to add link cards"). The author pastes a URL; the island `apps/web/src/scripts/reference-picker.ts` posts it through the new same-origin proxy `apps/web/src/pages/api/post-reference.ts` (cookie, Origin and CSRF forwarded; `postId` uuid-checked and stripped from the forwarded body) to `POST /posts/:id/references` and inserts `{{ref:TOKEN}}` on its own line at the cursor of the Markdown box. A 404, 422, 429 or network failure only shows a status message; the textarea is never touched. The control sits outside the editor form and is a bundled script, so the page CSP (`script-src 'self'`) holds. Verified by `apps/web/test/reference-picker.test.ts` (helpers, proxy, island source scan) and the rendered edit/create cases in `apps/web/test/new-post-page.test.ts`.

## 0.1.151 — M3.4a: attach a reference card to your own post (POST /posts/:id/references)

A verified author can ask for a card for a URL on their own post: `apps/api/src/routes/post-references.ts` wraps `attachReference` (`apps/api/src/references/attach.ts`) with the session pipeline, the shared `AttachReferenceInput` body (`packages/shared/src/references.ts`), a per-user limiter (`REF_ATTACH_LIMITER`, 10 a minute) and a per-origin limiter on the fetch door (`REF_ORIGIN_LIMITER`, 6 a minute per host), both in `apps/api/wrangler.jsonc`. A failure is 422 `REFERENCE_FAILED` with a `reason` and never loses the post. Pinned by `apps/api/test/references-attach-route.test.ts` (red first at f540c17, 5 of 6 failing with the missing route). The editor picker is M3.4b. NEW BINDINGS, no migration.
Dependencies: `.github/dependabot.yml` groups Dependabot into one weekly npm PR across the workspace (it opens no `changelog.d` fragment, so a lane folds its bumps into its own PR); `apps/web/package.json` takes astro 7.4.7 and fast-xml-parser 5.12.0 (the lockfile regenerated with `pnpm install --lockfile-only`), replacing Dependabot PRs 288, 289 and 305. CI on this PR is the check for both bumps.
Attach is refused with 403 `POST_UNDER_MODERATION` while a moderator or a pending auto-hide controls the post (the same freeze as an edit, #58; `apps/api/src/references/attach.ts` uses `POST_NOT_UNDER_MODERATION_SQL` at both ownership checks), pinned by `apps/api/test/references-attach-route.test.ts` (red first at 4c50cee3).

## 0.1.150 — M3.3 GitHub connector (dark until the App secret is set)

The GitHub connector reads public issues, pull requests, CI check runs and files with a line range (pinned to a commit SHA) and refreshes them by ETag. It is registered only when `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are both set, so a GitHub URL behaves exactly as before until the PM sets the secret. New: an authenticated-API path of the one fetch door (`apps/api/src/references/guarded-fetch.ts`): a constant allow-list (api.github.com only), no robots.txt on that path only, an opaque credential that never reaches a log, error or redirect. Verified by `apps/api/test/references-guarded-api.test.ts` (each refusal, and two mutants that were run and caught by name on CI), `apps/api/test/references-github-connector.test.ts`, `apps/api/test/references-github-file.test.ts`, `apps/api/test/references-github-installation-auth.test.ts`, `apps/api/test/references-github-app-auth.test.ts`, `apps/api/test/references-github-identify.test.ts` and `apps/api/test/references-registry-env.test.ts`. Not reachable from a post until the attach route (M3.4).

## 0.1.149 — M3.2d part 2: a public view wakes dormant references

Adds `apps/api/src/references/view-touch.ts` (`touchViewed`): a public read of a post records `last_viewed_at` on the references the post uses (throttled to one write a minute per reference) and wakes a dormant one by making `next_check_at` due now, so the next sweep tick claims it (plan decision 22). Wired into `apps/api/src/routes/public.ts` behind `REFERENCE_REFRESH`. Tested in `apps/api/test/references-view-touch.db.test.ts`.

## 0.1.148 — docs: ROADMAP restated true at origin/main bdc4d9f6 (0.1.144)

Restates `docs/ROADMAP.md`: the header (as of 0.1.144), the production-migration line in section 1 (0001-0043 applied, 0044 not, read back with `GET /health/schema`), the launch-gate bullet (`APP.live` is not readable from this repository, so the bullet now says what the repo can and cannot show) and the R11 row (M3.2 through the orphan GC, each done step with its test file, each open step with its blocker). No code change.

## 0.1.147 — test: fix the comments PATCH throttle flake (#300)

`apps/api/test/comments.test.ts` "throttles rapid PATCHes" looped 12 times after one create (13 calls) against a limiter of 10 per 60 s. The emulated limiter uses fixed wall-clock windows, so a window boundary inside those calls reset the count and no 429 appeared. The loop now allows 25 PATCHes, which cannot fit in one window of 10 or in two (20). Test only; no production code changed.

## 0.1.146 — docs: HANDOFF rewritten for 2026-11-16

Rewrites `HANDOFF.md` for the post-#307 state: open PRs #308, #309 and #311 with the PM, the retention ruling applied, the next row and refreshed waits. No code change.

## 0.1.145 — NEW MIGRATION 0044 `moderation_snapshots.card_snapshots`: reference cards kept in the evidence copy

Adds `apps/api/migrations/0044_moderation_snapshot_cards.sql` (nullable `card_snapshots jsonb`, additive). When an author deletes a post that is under moderation, `apps/api/src/routes/posts.ts` copies the card metadata of the post's references (token, kind, resource key, content hash, position and the whole stored card) into the moderation snapshot in the same statement, so the evidence no longer depends on the shared `"references"` row that `apps/api/src/references/gc.ts` may collect after a year. Tested in `apps/api/test/moderation-snapshot.test.ts`.

## 0.1.144 — M3.2d orphan-reference garbage collection

Adds `apps/api/src/references/gc.ts` (`gcOrphanReferences`): deletes `"references"` rows that no `post_references` row uses, once untouched for one year (the later of `created_at` and `updated_at`; the named constant `GC_RETENTION_MS`), at most 500 per run, `FOR UPDATE SKIP LOCKED`. The year is the retention floor from the #58 ruling (CireSnave: "minimum of 1 year"): a hard-deleted post's uses cascade away, so an orphan cannot be traced to a post, and no legal-hold table can name a reference. The evidence for a moderated post is kept in `moderation_snapshots`; a reference row is shared third-party page metadata, an ordinary cache past the floor. A NULL snapshot is not a reason to keep a row. Runs from `apps/api/src/references/refresh-wiring.ts` (`gcReferencesDaily`) on the existing `15 4 * * *` cron, dark unless `REFERENCE_REFRESH` is "1". No migration, no wrangler change. Tested in `apps/api/test/references-gc.db.test.ts`.

## 0.1.143 — CodeRipper pin moved to 0.47.5; rule ids migrated

The portfolio workflow pin in `.github/workflows/ci.yml` moves to coderipper c72a6e0 (0.47.5), and the `licence` waivers in `.coderipper.toml` use the new rule id `SUP-016` (via `tools/migrate-rule-ids.py`, idempotent). Pin and rename ship together because the old binary rejects numbered ids.

## 0.1.142 — M3.2c-3c reference-refresh wiring: queue, consumer, cron sweep (sweep OFF)

Wires the refresh engine into the Worker: the `reference-refresh` queue producer (`REFRESH_QUEUE`) and consumer in `apps/api/wrangler.jsonc`, a `queue()` handler, and the cron sweep on the two-minute tick, which claims due references and sends one message each. The sweep ships OFF (`REFERENCE_REFRESH` = "0"); the consumer is inert without messages. DEPLOY-GATED: the queue must exist before this deploys. Glue in `apps/api/src/references/refresh-wiring.ts`; red-first in `apps/api/test/references-wiring.test.ts` and `apps/api/test/references-wiring-config.node.test.ts`.

## 0.1.141 — HANDOFF rewritten for the post-M3.2c-3b state

Rewrites `HANDOFF.md` to the current state only: M3.2 merged through 2c-3b, the fragment and stamp flow, production migration state, the 2c-3c wiring plan, and the open waits. No code change.

## 0.1.140 — GitHub App ID and GitLab Application ID are public config, not vault secrets

Both IDs are public identifiers, and the vault refuses values under 12 characters. `apps/api/wrangler.jsonc` `vars` now carries `GITHUB_APP_ID` and `GITLAB_CLIENT_ID`; only the GitHub private key and the GitLab client secret are secrets (Worker secrets, set by the PM at deploy). `docs/runbooks/register-github-app.md` and `docs/runbooks/register-gitlab-oauth-app.md` are corrected to match. Pinned in `apps/api/test/github-app-config.node.test.ts` (red-first on CI), which also fails if a key or secret name enters the file. No code reads the vars yet; the M3.3 PR that does adds the named-error-on-missing-id test.

## 0.1.139 — deploy runbook waiting-migrations table, pinned

The "Migrations waiting" table in `docs/runbooks/deploy.md` said "(none), applied through 0040" while production lacked 0041 to 0043, because the PRs for 0042 and 0043 added prose sections but no rows. The table now reads applied through 0043 (2026-11-12), and `apps/api/test/deploy-runbook.node.test.ts` fails when a migration newer than the marker has no row. Verified red-first (2 of 3 tests failed on CI before the table was fixed).

## 0.1.138 — M3.2c-3b reference-refresh queue consumer logic

Adds `apps/api/src/references/refresh-consumer.ts`: `consumeRefreshBatch` runs one refresh per distinct reference id in a Queue batch, acks every finished refresh (including unknown and throttled outcomes, which the runner already rescheduled), acks and drops a malformed body, and retries a message whose refresh threw. Pure logic with the queue and the runner injected; nothing is wired, so there is no deploy impact. Verified red-first (6 failing tests on CI before the implementation) in `apps/api/test/references-consumer.test.ts`.

## 0.1.137 — CI: CHANGELOG fragments and a version stamp script

The gate stamps the version and the CHANGELOG entry from one fragment per PR, so parallel and stacked PRs stop conflicting on the five package.json version lines. The scripts are the portfolio kit (v3) plus an npm branch: `tools/stamp-version.py`, `tools/check-fragment.py`, `tools/stamp-current.txt` (names `package.json`), `.github/workflows/changelog-fragment.yml` and `changelog.d/README.md`. Checked with a real stamp run on this repo and on a fixture with a `package-lock.json` (only the two top-level version keys change).

Gap in this file: it has no entries for 0.1.130 to 0.1.134 (the per-PR entries were not written then; `git log` subjects name each PR). Nothing is backfilled here.

## 0.1.129

Docs only: HANDOFF refreshed after M3.1b; M3.2 (the refresh engine) is next. The version number is a placeholder, the PM allocates it.

## 0.1.128

Test only, no behaviour change. Proves the query-mismatch tests added in 0.1.127 fail without the fix: CI read them red when `keyOf` ignored the query match (`references-web-connector.test.ts`, the two new tests), then green again after the revert. The version number is a placeholder, the PM allocates it.

## 0.1.127

M3.1b: the reference store and render. **NEW MIGRATION 0042** (`0042_references.sql`: the `"references"` and `post_references` tables, additive). `renderMarkdown(markdown, { refs })` renders `{{ref:TOKEN}}` as a card (pure `renderRefCard` in `packages/markdown`; an unknown token renders nothing; tokens in code stay literal; `PIPELINE_VERSION` is now v2 because a post with an unknown token renders differently); the `web` connector, the connector registry, `attachReference` (dedupe, 10 per post, per-user limit, never loses the post), `loadRefCards`, and `GET /public/posts` carrying `refs`; the post page passes them to the renderer with a CSP `img-src https:` allowance for card images on that page only; the `/bot` page. The per-origin fetch rate limit deferred from M3.1a is now implemented (`withOriginLimit`, injected limiter). Not wired yet: the `POST /posts/:id/references` route and the rate-limit bindings (M3.4, with the picker). The version number is a placeholder, the PM allocates it.

## 0.1.126

M3.1a: the reference engine's pure foundation (no database, no migration, no UI). Contract types, `capSnapshot` and `contentHash` in `packages/shared`; the SSRF URL guard, the guarded fetch door (manual redirects, DNS-over-HTTPS check, 5 s timeout, 512 KB counted body cap, content-type and robots.txt checks) and the tolerant Open Graph extractor in `apps/api/src/references`; a source-scan test that no connector calls global `fetch`. Nothing calls them yet (M3.1b wires the web connector). The per-origin rate limit of spec section 5 rule 6 is deferred to M3.1b; this change does not include it. The version number is a placeholder, the PM allocates it.

## 0.1.125

M3.0: the connector contract spec (`docs/superpowers/specs/2026-11-09-m3-connector-contract.md`), Q1-Q5 recorded in the plan, ROADMAP R11 and S1 updated (launch set shrunk; unfurl images store the address only, with a seam for a stored copy). Docs only, no code. The version number is a placeholder, the PM allocates it.

## 0.1.124

Two one-page runbooks for CireSnave: registering the GitHub App (M3.3) and the GitLab OAuth application (M3.6), with exact settings, read-only permissions and vault names. Docs only. The version number is a placeholder, the PM allocates it.

## 0.1.123

Upload-scan design: D6 ruled A by CireSnave (2026-11-07), so a cleared file may be published again while its clearing matches the current hash-service list version; the flow and test list no longer say refuse. Docs only, no code (upload-scan build still held). The version number is a placeholder, the PM allocates it.

## 0.1.122

HANDOFF.md refreshed for the M3.0/M3.1 task and the armed waits. Docs only; the version number is a placeholder, the PM allocates it.

## 0.1.121

ROADMAP S13 corrected: a moderator decision's duration is already recorded (`durationHours` -> `action_expires_at`, #189); the row was stale. Docs only; the version number is a placeholder, the PM allocates it.

## 0.1.120

HANDOFF.md refreshed to current state (S12 merged, S4 closed). Docs only; the version number is a placeholder, the PM allocates it.

## 0.1.119

The auto-hide notice to the author goes through the notice outbox (ROADMAP S12): `maybeAutoHide` queues an `author_auto_hide` row in the hide's own transaction, so a hide that cannot be announced rolls back, the drain delivers it with retries, and the report route no longer sends mail. Same copy, no appeal link. No migration (the kind is already in the 0034 CHECK). The version number is a placeholder; the PM allocates it.

## 0.1.87

The appeal page states the legal and contractual grounds the decision cited (ROADMAP R7), so it matches the author notice: `AppealTarget` carries the optional grounds and `appeal.astro` renders them. No migration.

## 0.1.86

Docs matched to the code (the rest of ROADMAP S29): README status line and stale baseline, dated update notes on the design spec, queue design, deploy-automation design, CSAM design, SafeImage split, guidelines-intentions and outbox design, `legal/README.md`, `deploy.md` order constraint, and superseded banners on the 10-14 outbox design and the NCMEC notes. Original text is kept; no published wording changed.

## 0.1.85

Docs matched to the code: the privacy policy now describes the device cookie and known-browser list; the Community Guidelines (version 2026-10-25) say the 30-day appeal window starts when the decision email is delivered; the glossary and `pre-launch-fixes.md` no longer call the appeal form and login challenge unbuilt.

## 0.1.84

Spec-to-roadmap audit: ROADMAP section 7 lists the work found in the docs and not on the roadmap (S1-S29), and section 2 drops the rows that have since merged. Docs only.

## 0.1.83

Author decision notices now state the legal and contractual grounds a moderator cited (adverse decisions only; a restore never shows them), and ROADMAP section 3 lists rows R1-R7.

## 0.1.82

Raised @astrojs/check 0.9.10 to 0.9.12 and repinned the CodeRipper `portfolio.yml` workflow to 0.9.24 (ee9c3950). TypeScript stays on 6.0.3: @astrojs/check 0.9.12 still peers `typescript ^5 || ^6`.

## 0.1.81

Refreshed HANDOFF to the post-dependency-upgrade state.

## 0.1.80

Raised vitest 4.1.11 to 5.0.5 and moved `@cloudflare/vitest-pool-workers` 0.22.0 (renamed upstream, 0.23.0 is its last release and caps vitest at ^4) to its successor `@cloudflare/vitest-plugin` 1.4.7. TypeScript stays on 6.0.3: `astro check` refuses TypeScript 7.

## 0.1.79

Raised zod to ^4.6.7 (supersedes the dependabot PR #222).

## 0.1.78

Raised astro 7.3.5 to 7.4.2 and @astrojs/cloudflare 14.3.3 to 14.4.2 (build, typecheck and the web suite pass; the no-store guard in `workers-cache.test.ts` still finds the adapter stamp).

## 0.1.77

Waived the two wrangler-generated `worker-configuration.d.ts` files from the CodeRipper `licence` rule in `.coderipper.toml`.

## 0.1.76

Added `SPDX-License-Identifier: MIT OR Apache-2.0` headers to 643 source files with `scripts/add-spdx-headers.mjs` (`--check` lists what is missing) (#224).

## 0.1.75

Added `CHANGELOG.md` (CodeRipper `version-and-changelog` rule, ROADMAP section 3).

## 0.1.74

Waived three test-fixture SEC-002 hits in `.coderipper.toml` and repinned the CodeRipper portfolio caller to 0.9.14 (#225).

## 0.1.70

Added the advisory CodeRipper `portfolio` CI job (not a required check) and the ROADMAP rows its findings produced (#221).

## 0.1.69

Refreshed the shared-crate fit note (#220).

## 0.1.68

Refreshed ROADMAP section 3 and HANDOFF (#219).
