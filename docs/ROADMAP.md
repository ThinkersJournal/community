# Thinker's Journal Community — roadmap

**As of:** `origin/main` 06f90e0 (package version 0.1.67), 2026-10-18 (§3 only; §1 and §2 predate it). This is the project's own view of order and
state. The portfolio roadmap sits above it and wins on priority; CireSnave's decisions win on everything. It is a
plan, not a promise: items are in the order the lane intends to take them, and anything marked **held** waits on a
person, not on code.

**How to keep it true:** every line below names the PR, issue or document it comes from. If a line cannot name
one, delete it. Re-read `git log origin/main` and `gh pr list` before relying on a state.

## 1. Where the platform is

- **Live** at `community.thinkersjournal.com` (DNS cut over 2026-09-02). M0 foundations, M1 publishing and the
  public web, and all of M2 (social graph, engagement, notifications, search, discover, tags) are built, reviewed
  and merged; every named pre-launch fix has shipped. Source: `HANDOFF.md`, `docs/pre-launch-fixes.md`.
- **Public launch is gated on M4**, not on M2: moderation, DMCA, CSAM detection and NCMEC reporting, and legal
  review must all hold before the community opens (`APP.live` stays off until every item in
  `docs/superpowers/specs/2026-10-07-upload-scan-design.md` §11.2 holds).
- **Runtime database role:** the Workers authenticate as the least-privilege `app_runtime` role (observed
  2026-10-12, #169; spec `2026-09-02-least-privilege-db-role-design.md`).
- **Production migrations:** 0001–0025, 0027 and 0029–0032 applied (0026 and 0028 are not in use). Source: the PM's
  merge notices for #161, #189, #191, #192 and #193, 2026-10-15. Re-check `GET /health/schema` before trusting it.

## 2. In flight, and what each is waiting on

| Item | State | Waits on |
|---|---|---|
| **Login Turnstile challenge**, implementation | built and reviewed locally, not pushed | rebase onto `main` (#160 merged in #201); design `2026-10-11-login-turnstile-challenge-design.md`, rulings in its §9 |
| **Security alerting PR 3** | complete locally, not pushed | rebase onto `main`; renumber its migration after 0032 |
| **Media ownership records** (clear `media.owner_id` on anonymisation, keep hashes, hold-aware) | plan approved, nothing written | a version from the PM, then a migration CireSnave applies before merge (#161 merged) |
| **Idempotency key on `POST /posts`** (for the CodeRipper "post results" flow) | design note next | a version from the PM, then a migration CireSnave applies before merge |
| **HMS_A_BASE_URL origin-only** (upload-scan design §8.3) | #170 open, docs only | gate |
| **Moderation notice outbox** (#57; board 194 ruled: window from delivery, 365-day retention, dispute@ in every notice, types 1–5) | design note #197 open, docs only | gate, then implementation PRs each needing a migration CireSnave applies |

## 3. Unblocked, in the order I would take them

Rows from the advisory CodeRipper check (#221, `portfolio` job, run 40005620570, 2026-10-23; the check is not required):

1. **version-and-changelog:** DONE in the changelog PR (0.1.72); keep `CHANGELOG.md` current with every version.
2. **licence:** DONE in the SPDX PR (0.1.73): `scripts/add-spdx-headers.mjs` (idempotent; `--check` lists what is missing) added
   `SPDX-License-Identifier: MIT OR Apache-2.0` to 643 files. The 2 wrangler-generated `worker-configuration.d.ts` files stay headerless on
   purpose (Apache-2.0 only, not ours to relicense per LICENSE.md section 1, rewritten by `wrangler types`), waived by `[[allow]]` in `.coderipper.toml` (0.1.77). Run `--check` before merging a
   PR that adds source files.
3. **SEC-002:** DONE in #225 (0.1.74): the 3 fixture hits are waived by `[[allow]]` entries in `.coderipper.toml`.

Nothing is unblocked (`origin/main` b8f3dc2, 2026-10-24). Open issues: #114 (NCMEC pipeline; waits on
CireSnave's inputs, board 119) and #72 (file-picker report, environment-suspected, low; no work until it recurs).

Closed since the last refresh: #57 (outbox, #197 and follow-ups), #78, #148, #156, #39, #40, #59, #60, #65, #85
(already fixed by #182), #84 (unmigrated local dev DB; #218 adds an e2e preflight) and #74 (audit refreshed in
#217: 0 bucket A, 0 bucket B of 104 routes).

Parked, not queued: an audit row for a notice resend (`POST /admin/notices/:id/resend` logs the row id only; a
`moderation_actions` row needs a new kind, so a CHECK migration). PM ruling 2026-10-17: not now.

## 3b. Guideline and reality gaps (CireSnave asked, 2026-10-15)

Where the published rules and the platform differ. Source for every row: the audit
`docs/superpowers/specs/2026-10-14-guidelines-match-audit.md` (#190, closed unmerged), re-verified in code by the lane.

| # | Gap | Decision | Source |
|---|---|---|---|
| 1 | **Terminate path for the CSAM/severe case**: `user_terminate` exists as a primitive (`apps/api/src/moderation/account-actions.ts`) but no admin route reaches it, so "immediate termination" is not something a moderator can do | the notice text is ruled and built (`renderTerminationNotice`, #200). The moderator route `POST /admin/accounts/:handle/terminate` (+ a confirmed form on the account page) is built: the notice goes through the notice outbox, queued in the action's transaction | audit §3.2; `admin-accounts.ts:114`; issue #114 |
| 2 | **NCMEC reporting and CSAM detection** are not live | already the launch gate; plan `plans/2026-10-01-csam-ncmec-pipeline.md`; upload scan D7/US2 designed and **held** | upload-scan design §11.2; this file §4 |
| 3 | **Public legal pages**: only `/dsa-notice` exists. `/guidelines` shipped in #198; `/terms`, `/privacy` and `/dmca` have no route and the footer links the external marketing URL for Privacy | build `/terms`, `/privacy`, `/dmca` and footer links after their texts are decided | `apps/web/src/components/Footer.astro:26`; `docs/legal/README.md` |
| 4 | **Notices carry the clause and ground** | shipped: #192 (grounds recorded; rendering them in notices is a follow-up) and #193 (redress sentence, stored copy) | #192, #193 |
| 5 | **`other` has no clause; doxxing, impersonation and malware wording**; one `sexual` bucket holds CSAM and NCII | wording goes into the publishable guidelines text; splitting the bucket is not planned | audit §1 |
| 6 | **Bad-faith-report detection and handle reclaim** are NOT being built | the published text says only what is true today: moderators may warn, suspend or ban by hand | audit §3.2 |

## 4. Held, by design

- **Upload scanning (D7 / US2)** is designed and **not released**: no building until the PM releases it. The
  provider is referred to only as "hash-matching service A"; the registration and its secrets are CireSnave's.
- **SafeImage adoption** (layers 1–5 as a crate, `2026-10-10-safeimage-split.md`): steps 3–5 wait on the crate
  being publishable (decision Q8).
- **TypeScript 7 (2026-10-24, PM-accepted exception to the latest-dependencies rule):** blocked on Astro stable support. `astro check`
  exits "does not currently support TypeScript 7.0" (experimental support needs TS 7.1+, still beta), and TS 7 no longer exports the
  compiler API that `hidden-at-read-guard.node.test.ts` and `login-bar-after-verify.node.test.ts` import. Stay on 6.0.3; revisit when
  `astro check` supports 7.x.
- **Legal entity** stays `[[LEGAL_ENTITY]]` everywhere until the registration is confirmed.
- **D11 (recheck)**, the live-chat concept (`docs/superpowers/backlog/2026-07-21-live-chat-concept.md`) and the
  interaction-permissions maybes are post-launch and unstarted.

## 5. Decisions that wait on CireSnave

Filed on the PM's board, never asked directly by this lane: legal entity registration; alert transport and the
privacy wording for it; `DEVICE_HASH_KEY`; applying 0027; the VPS image-service checklist and the ICC-warning rule;
SafeImage publishing (Q8) and where the provider profiles live (Q9).

## 6. Rules every item inherits

Dependencies at their latest versions; versions change with every pushed change (the PM allocates the number);
nothing runs against production from a lane; migrations are applied to production before the PR that needs them
merges; every vendor name stays out of this public repo.
