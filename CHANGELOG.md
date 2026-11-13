# Changelog

All five workspace packages carry one version number. The log starts at 0.1.68; earlier history is in `git log`
(subjects name the PR). Pre-1.0, a breaking change moves the second number.

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
