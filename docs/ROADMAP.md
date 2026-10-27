# Thinker's Journal Community — roadmap

**As of:** `origin/main` e1c241c (package version 0.1.82), 2026-10-24 (§2 and §7 refreshed; §1 predates it). This is the project's own view of order and
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

Nothing is in flight apart from the open PRs on the forge. The rows this section used to carry are all merged: the login Turnstile
challenge (#203), security alerting PR 3 (#204), media ownership records (#207), the idempotency key on `POST /posts` (#211),
`HMS_A_BASE_URL` origin-only (#170) and the moderation notice outbox (#197, #205, #210, #213, #214, #215). Migrations 0033-0038 are on
`main`; which of them are applied to production is not recorded in this repository (the PM's notices are the source).

## 3. Unblocked, in the order I would take them

Rows from the advisory CodeRipper check (#221, `portfolio` job, run 40005620570, 2026-10-23; the check is not required):

1. **version-and-changelog:** DONE in the changelog PR (0.1.72); keep `CHANGELOG.md` current with every version.
2. **licence:** DONE in the SPDX PR (0.1.73): `scripts/add-spdx-headers.mjs` (idempotent; `--check` lists what is missing) added
   `SPDX-License-Identifier: MIT OR Apache-2.0` to 643 files. The 2 wrangler-generated `worker-configuration.d.ts` files stay headerless on
   purpose (Apache-2.0 only, not ours to relicense per LICENSE.md section 1, rewritten by `wrangler types`), waived by `[[allow]]` in `.coderipper.toml` (0.1.77). Run `--check` before merging a
   PR that adds source files.
3. **SEC-002:** DONE in #225 (0.1.74): the 3 fixture hits are waived by `[[allow]]` entries in `.coderipper.toml`.

Rows (PM ruling 2026-10-24: R1-R6 as listed, R2 first). Open issues: #114 (NCMEC pipeline; waits on CireSnave's inputs, board 119) and #72 (file-picker report, environment-suspected, low; no work until it recurs).

| Row | Work | Status |
|---|---|---|
| R1 | `/terms`, `/privacy`, `/dmca` routes and footer links (section 3b #3) | waiting: the legal texts are not decided (CireSnave) |
| R2 | Render the cited legal and contractual grounds in the author decision notice (#57 Art. 17; section 3b #4 follow-up) | in progress (adverse decisions only) |
| R3 | Audit row for a notice resend (needs a new `moderation_actions` kind, so a CHECK migration) | parked: PM ruling 2026-10-17, not now |
| R4 | Drop `moderation_notice_records` (0032) and its purge cron once its rows have aged out | open, unblocked only after the retention window passes |
| R5 | `APPEAL_WINDOW_DAYS` is 30 but DSA Art. 20(1) needs complaint access for at least 6 months | held by the PM |
| R6 | SafeImage adoption steps 3-5 and the workerd proof (cold start, memory) | waiting: package not published (decision Q8, board 247) |
| R7 | Show the cited grounds on the appeal page (`AppealTarget`, `routes/appeals.ts`, `appeal.astro`) so both surfaces state the same grounds | done (0.1.87): `AppealTarget` carries both grounds, the appeal page renders them |
| R8 | Patent sweep, the areas not yet searched (theming, editor UI, Postmark integration, deploy pipeline): at most 1 Google Patents query per minute, back off on a 503 and say so in the record; read claims with `tools/patent-claims.py`; areas not searched stay listed as unsearched in `docs/PATENT-SWEEP.md` (PM 2026-10-25) | open, unblocked |
| R9 | DMCA takedown, counter-notice and repeat-infringer flow (S2): one-page design note first, then intake, hide and notify, counter-notice, restore timer, strike count; numbers are placeholders for the attorney | in progress (CireSnave ruled "build it" 2026-10-25): intake + migration 0040 (0.1.102, applied); moderator decision, author and claimant notices, admin page, standing-takedown count (0.1.103); counter-notice, forward to the claimant, restore timer (10 business days, CireSnave 298 A), claimant-sued and withdrawn records (0.1.105); repeat-infringer count + flag (3 in 12 months, a moderator terminates) and 3-year erasure of closed cases (0.1.106). The `/dmca` policy page itself is R1 |
| R10 | Terms acceptance record at signup (S6): checkbox, stored account/time/Terms version, one migration CireSnave applies; the minimum age (13 in the drafts, 16 in design decision 15) must be settled first | built (0.1.100): age 16 ruled by CireSnave 2026-10-25, migration 0039, both drafts say 16 |
| R11 | **M3 live-reference engine** (S1 b: launch is held until it exists): connectors, snapshot, access-driven refresh, picker, private-resource safety, per-source terms and budgets; tasks M3.0-M3.10 in `docs/superpowers/plans/2026-10-25-m3-reference-engine-plan.md` | plan written (0.1.109); M3.0 waits on Q1-Q5 (CireSnave, via the PM) |

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

## 7. Spec-to-roadmap audit (2026-10-24, PM request)

Method: every document under `docs/` (specs, designs, audits, legal drafts, ops, runbooks, backlog, spikes), plus `README.md` and
the glossary, was read at `origin/main` e1c241c and each piece of described work checked against the code (`git grep` with a positive
control) and the merged PRs. Plans were read for their deferred and follow-up sections only. Documents read: 60 (the plan files
grep-only, on top). Items already rows above (R1-R7, #114, upload scan, SafeImage, TypeScript 7, live chat, D11) are not repeated.
**Status:** open (unblocked), held (by whom), done (PR). **CC** = needs a CireSnave decision, filed on the PM's board by the PM.
Each claim is from one read of the code at that ref, so re-check before relying on a row.

| Row | Work and source | Status |
|---|---|---|
| S1 | **M3 Reference engine** (connectors, snapshot capture, @-picker, refresh sweep; design spec §4, README tagline). No code, no migration, and no row until now | ruled 2026-10-25 (S1 b): launch is HELD until M3 exists; plan in `docs/superpowers/plans/2026-10-25-m3-reference-engine-plan.md` (0.1.109, open questions Q1-Q5 for CireSnave) |
| S2 | **DMCA takedown, counter-notice and repeat-infringer process** (design spec M4; `dmca-policy.md` promises it). Only a legal-hold category exists in code | open; ruled 2026-10-25: build it (row R9) |
| S3 | **README Deploy gate dashboard items**: WAF block on `/internal/*`, WAF rate-limit on public reads, CDN Cache Rule, `nosniff` Transform Rule, CSAM Scanning Tool on the CDN zone, Postmark and purge log alerts, `workers_dev` off on the web Worker (the api has it) | held by CireSnave; **CC**: which are done |
| S4 | App-level rate limit on the other `/public/*` reads (`posts`, `recent`, `discover`, `tag(s)`, `authors`, `comments`); search (#117) and profile are done | open |
| S5 | Sitemap index and real pagination of `/public/recent` (`RECENT_MAX = 1000`, `public.ts:71`) | open, post-launch |
| S6 | Signup 16+ attestation and a Terms-acceptance record at signup (design spec decision 15; the Terms say account creation is agreement, and nothing records it) | open; ruled yes 2026-10-25 (row R10); age still **CC** |
| S7 | Privacy policy omits what the code does: the device cookie and known-device list (#201), the client-country header, the notice outbox and stored notice text (365 days), permanent original-upload hashes with the owner cleared (#161, #207); alerting spec D5 | the three missing sentences added to the draft (0.1.98), CireSnave ruled 2026-10-25; attorney still to review |
| S8 | Alerting phase 1b and 2: set `ACCOUNT_NOTICES_ENABLED` to 1 (needs `DEVICE_HASH_KEY` in production), the alert transport and `SECURITY_ALERT_*` secrets, flip `SECURITY_ALERTS_ENABLED`, review a week of `security-alert:` log lines (D3), accept the held-row caps (D6) | held by CireSnave (board 131, D1) |
| S9 | External uptime monitor and the one-time paging proof (`docs/ops/uptime-monitor-spec.md`; alerting D2) | held by CireSnave (signup) |
| S10 | Turn `LOGIN_CHALLENGE` on (ships `"0"`; one-line PR once the web side is live); check WCAG 3.3.8 and keyboard reach of the widget; the optional privacy sentence | flag set to "1" (0.1.101, CireSnave 2026-10-25 "C"); still before launch: keyboard/WCAG 3.3.8 check of the widget and the optional privacy sentence |
| S11 | `dispute@` contact line on the `/appeal` page (outbox design §8; the emails already carry it) | done (0.1.89) |
| S12 | Route the auto-hide notice through the outbox (kind `author_auto_hide` is in the 0034 CHECK and has no enqueue site; `reports.ts` still sends best effort) | open |
| S13 | Content decisions never record a duration (`decide.ts` does not pass `actionExpiresAt`; recorded only, nothing un-hides) | open, low |
| S14 | Notice wording rulings: say the hide was automated, an outcome email to a member reporter, restore and appeal-denied treatment (art17 facts Q4, Q10, Q11) | ruled 2026-10-25 (B/B/B): auto-hide email says it was automatic and the `content_auto_hide` action row already exists (#57, 0030); restore and appeal-denied emails left as is; member reporter outcome email built (0041, 0.1.107) |
| S15 | Deploy: confirm the one-time Cloudflare build-command change for the migration gate was made; auto-rollback needs a deploy credential; a notification channel for pipeline failures (`deploy-automation-design` §3, §4) | ruled 2026-10-25: (a) the build-command gate is in place (confirmed); (b) automatic rollback built, off until `rollback-check` passes and AUTO_ROLLBACK_ENABLED=1 (Environment and secrets exist, board 305) (design `2026-10-25-auto-rollback-design.md` section 3, 0.1.108); (c) the failure channel is still open |
| S16 | Ruling (f): the number of Access admins, a precondition for both two-person rules in #114 (csam design §0) | held by CireSnave; **CC** |
| S17 | Upload-scan decisions D1-D4, D6, D7, D11, D12, D16, D17, and `anim: false` in `toWebp` (flatten animation, Q4/D2) | ruled 2026-10-25 (design section 0.4): D1, D2, D4, D17 yes, D3 block, D6 publish a cleared file tied to the list version (PM default), D7 ImageMagick on the VPS, D11 build (task US10, not a launch blocker), D16 join the live review case and hold; D5, D8-D10, D12-D15 are the PM's. Still held: the upload-scan build itself (D12, HMS-A registration) |
| S18 | VPS image service: the 13-item host checklist, the ICC-warning rule, a real-world corpus for the flat-image share (C8) | ruled 2026-10-25: (a) `scripts/verify-host.sh` written (0.1.110; read-only, prints the 13 settings for CireSnave to run on the VPS and paste back); ICC rule: reject and count; the flat-heavy corpus measurement is still to do (needs the PDQ port and a public-domain set) |
| S19 | `docs/runbooks/csam.md` (destruction request, incident, NIST mapping; upload-scan US9 additions) | held with #114 |
| S20 | `fast-xml-parser` in `apps/api`, the version-pinned characterisation test and the response byte cap (xml-parser decision §6) | held with #114 |
| S21 | SafeImage Q7: the workerd proof of the pdq `.wasm` (cold start, memory) and the hash self-test identity gaining the crate version | waits on a published `@thinkersjournal/safeimage` (board 247) |
| S22 | Page-audit leftovers: F4 `/appeal` for a banned or lost-email user, F7 no "Report illegal content" link on live-inserted comments or in the footer, F8, F9, F10 done (0.1.90); F7 live-comment link done (0.1.91); F4 left by design (PM 2026-10-25: the token email is the route) | F7 footer link and URL field done (0.1.92) | done |
| S23 | Fill `[[REAPER_WINDOW]]` in the legal drafts: the code is 7 days (`reap-unverified.ts:70`) | done (0.1.88) |
| S24 | Renew the DMCA agent registration every 3 years (the README gives no date) | done (0.1.99): registered 2026-09-05, renew by 2029-09-05, recorded in `docs/legal/README.md` |
| S25 | Post-launch backlog, unqueued: @-mentions, notification pruning, KV unread count, Postmark bounce webhook, digest timezone, "Mark all read", search snippets and autocomplete, tag curation and rename, per-post OG images, About page, trending and a follow recommender, who-reacted lists, mute, avatar variants, dropping CSP `style-src 'unsafe-inline'`, a per-account post rate limit, "More" paging in follow lists | open, post-launch |
| S26 | Old design decisions never built and never withdrawn: tag creation gated to accounts older than 7 days, spam heuristics and pre-publish moderation scoring (`[[MODERATION_SCORER]]` is still in the privacy draft) | ruled 2026-10-25 (c = build both): the 7-day tag gate is built (0.1.111, #261); the scoring design is written (`2026-10-25-moderation-scoring-design.md`, 0.1.112), vendor open; `[[MODERATION_SCORER]]` stays until a vendor is chosen |
| S27 | Guidelines promises versus the product: restore the "immediate termination" statement now that the terminate route exists (#212; needs a version bump), a different reviewer for appeals (`appeals.ts` reports `sameReviewer` and never refuses), change announcements and an acceptance record | ruled 2026-10-25: "immediate termination" sentence restored (0.1.99, Guidelines 2026-10-25.2); keep "where practical" for appeals, make the same-reviewer refusal real once a second admin exists (S16); the change notice and acceptance record are built with S6 (#249) |
| S28 | `pgmigrations` tightening for the runtime role (least-privilege spec §8 item 3, never recorded as answered) | open, undecided |
| S29 | Docs that contradict the code, to correct (docs only): README status line and baseline table; glossary appeal window and Turnstile lines; `pre-launch-fixes.md` #6 and #7 (the appeal form exists); design spec §3 "nothing writes those columns"; queue design §5 and §11.2; deploy-automation header against its §7; NCMEC notes §3 against the pipeline design; csam design "next migration is 0026" and "gated on CireSnave"; the 10-14 outbox design (superseded, no banner); safeimage-split §1; guidelines-intentions rows 1 and 11; the outbox design's `author_auto_hide` appeal link; `legal/README.md:76`; `dmca-policy.md` §4 ladder; `deploy.md` order constraint | mostly done: the privacy policy, Guidelines §4, glossary and pre-launch list in #234, the rest in the follow-up docs PR (0.1.86). Left: `dmca-policy.md` §4 cites a warn-suspend-ban ladder that the published Guidelines do not require (legal text, on CireSnave's board 287) |

Done and verified while auditing (no row needed): the pre-launch fixes (#18, #19, #20, #118, #144), block and report retrofits (#30, #31, #94),
queue and admin (#96, #97, #125), enforcement ladder (#132), appeals (#144), DSA intake (#134), legal hold (#139), terminate route (#212),
notice outbox (#205, #210, #213, #214, #215), media ownership (#207), idempotency key (#211), login challenge (#203), alerting phase 1
(#157, #201, #204), upload-scan schema (#161), the deploy gate (#136).
