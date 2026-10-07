# Security alerting, phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 3.** Revision 2 answered the audit of `7550cc0` (1 Critical, 11 Important, 10 Minor); revision 3 answers the re-audit of `6b3bcdb` (R2-1 to R2-3), each under the PM's rulings. The last section maps every finding to its fix.

**Goal:** Ship phase 1 of the security-alerting design with every flag off: every `security:` event is counted in Durable Objects, threshold crossings are decided by one ledger with per-class budgets and reported through the seam to the log sink, browsers are recorded per account so account-holder notices are ready for phase 1b, and admins get the ref lookup, the full held list and a liveness health route. No transport: board 131 later replaces `null` in one call.

**Architecture:** `logSecurityEvent` gains an in-process observer. On the api it feeds a per-isolate `SecurityEventBuffer` through `withSecurityScope` (the only change to the pinned dispatcher besides two exports and one cron line). The buffer flushes, in the request's `waitUntil`, to 33 fixed `SecurityCounterDO` instances. Counters report crossings to one `SecurityLedgerDO`, which decides (cooldowns, budgets, held subjects, refs, the anonymisation tombstone), and its alarm delivers through `deliverSecurityAlert` to `LogSecurityAlertSink`. The web purge route feeds the same buffer class through a cross-script binding. `UserSecurityDO` gains the device list, notice caps, one pending notice per kind and an in-flight row, with an alarm. Postgres changes in one way only: one additive `moderation_actions` constraint migration (PR 3).

**Tech Stack:** TypeScript 6.0.3 on Cloudflare Workers (`apps/api`, `apps/web` on Astro 7), SQLite-backed Durable Objects, Workers KV (`HEALTH`), Postgres via Hyperdrive, Postmark "outbound", vitest 4.1.11 with `@cloudflare/vitest-pool-workers` 0.22.0 (api pool + node projects), plain-Node vitest (shared, web).

**Spec:** `docs/superpowers/specs/2026-10-07-security-alerting-design.md` (revision 5, merged in #153). **Read all of it, including §9's audit table.** Every "§n" below is a spec section. This plan implements the spec; every departure is a ruling in the table below, with its spec citation and, where the PM ruled, the ruling's id. Nothing else departs from the spec.

## Preconditions

Checked against `origin/main` at `f3da62d` (version 0.1.7) on 2026-10-07. `origin/main` has since moved to `f4dff60` (#154), which changes docs only (the CSAM specs); no anchor below moved.
- The spec is merged (#153). `logSecurityEvent` is `packages/shared/src/security-log.ts:33-45`; its five callers are the ones §1.1 lists.
- Migrations end at `0025_drop_reserved_email_sha256.sql`; the latest `moderation_actions_action_check` list is `apps/api/migrations/0022_account_legal_holds.sql:69-79` (0023–0025 do not touch it).
- The api has three Durable Object classes and migrations `v1`–`v3` (`apps/api/wrangler.jsonc:93-104`); the web Worker has none (0 hits for `durable_objects` in `apps/web/wrangler.jsonc`; the same grep finds `apps/api/wrangler.jsonc:93`). Neither file has a `vars` block (0 hits for `"vars"`; the same grep shape finds `"ratelimits"` in both).
- The dispatcher pin is `apps/api/test/route-protection.test.ts:159-216` (`EXPECTED_DISPATCHER_BODY` at `:165`).
- The runbook is `docs/runbooks/deploy.md`; its secret precedent is "One-time secret: `RESERVED_EMAIL_KEY`" (`:143-168`).

## Global Constraints

- ⚠️ **Test databases (PM, revision 2): use ONLY `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/thinkersjournal_test_appeals`. Never create a database on the shared local Postgres, and never run `test/migrations.db.test.ts` locally** (it defaults to the shared `thinkersjournal_migrations_test` and drops every table in it; CI runs it). Every api command below spells both: `TEST_DATABASE_URL=…_appeals` and `--exclude test/migrations.db.test.ts` when it runs the whole suite.
- **Flags (§6 phase 1):** `SECURITY_COUNTING="on"`, `SECURITY_ALERTS_ENABLED="0"`, `ACCOUNT_NOTICES_ENABLED="0"` in each `wrangler.jsonc` `vars` block. Nothing in this plan turns a notice or a transport on.
- **No transport.** `selectSecurityAlertSink(env, null)` appears in exactly one place, `SecurityLedgerDO.sinkFactory`'s default. Board 131 changes that `null`.
- **No admin link before the admin page (I-11).** PR 1 and PR 2 messages carry refs and counts only; `SecurityHeldReport.adminUrl` is `null` until PR 3 sets it.
- **The version bump is NOT in this plan.** The PM allocates the number per PR at the gate, as that PR's last commit.
- **Codacy:** no NEW function over 50 lines, and no non-null assertion (`!`) in new or changed code, tests included. Exception (M-7), stated so nobody chases it: this plan adds lines to functions that already exceed 50 (`handleLogin`, `handleSignup`, `resetPassword`, `anonymiseExpiredAccounts`, `handlePurgeRequest`); each addition is one call into a new, short module.
- **Secrets by key name only.** Fixtures use `example.invalid` / `example.test` addresses and obviously fake keys. Never a real name, email or address in code, tests, docs, commits or PR text.
- **Every Durable Object or rate-limit binding** goes into `wrangler.jsonc` AND the hand-added section of `worker-configuration.d.ts`, and is reachable in the vitest config (ruling P-9 says how).
- **No test sleeps on a Durable Object.** Each class exposes `recordAt`/`reportAt`/`alarmAt` with an explicit clock, called through `runInDurableObject`; real alarm scheduling goes through an `armAt` seam the tests replace (P-8), and claims made in tests go through it too (I-5). The one exception is the real-alarm cron test (bounded poll).
- **Enumerate from the index** (`git ls-files`), never by walking the disk (portfolio `CLAUDE.md` §5b).
- **PR text:** each PR body says "Part of the security-alerting work (spec #153)"; no closing keyword next to an issue or PR number.
- **Line endings:** checkouts here are CRLF in the worktree and LF in the index (`.gitattributes`: `* text=auto`). Never byte-compare a worktree file.

## Rulings on what the spec leaves open

| # | Spec gap | Ruling | Cite |
|---|---|---|---|
| P-1 | §2.4 names `ledger.report(reports)` and `site.summarise(fromMinute, toMinute)` but types neither, and a counted-not-stored overflow has no per-class shape. | `packages/shared/src/security-ledger-types.ts`: `CounterReport` (raw subject; only the ledger mints refs), `LedgerReportBatch { reports, countedOverflow: Partial<Record<SignalClass, number>> }`, `SiteSummary` over the half-open minutes `[from, to)` (M-5). | §2.4 step 4, m4; §2.6 step 5 |
| P-2 | *(withdrawn in revision 2)* §3.2's `DigestClassLine.activity.distinctPrefixes` has no source in §2.3. | **PM ruling I-8: dropped.** `classify` stays the spec's block as merged; `activity` carries `events` only; PR 1 adds a one-line amendment to the spec (Task 2). | §2.3, §3.2 |
| P-3 | §2.6 F3 says digests and held reports carry the counted-not-stored totals, and §4.4 that extra notice drops are "counted for the digest"; no type has a field. | Additive fields: `DigestClassLine.heldCountedNotStored`, `SecurityHeldReport.countedNotStored`, `SecurityDigest.noticesDropped`. `SecurityHeldReport.adminUrl` becomes `string \| null` (I-11). | §2.6 F3, §3.2, §4.4 |
| P-4 | §2.6 step 7 budgets pruning at "2 s"; workerd's clock advances only on I/O (`apps/api/test/helpers/limiter-window.ts:43-51`). | 5 chunks of 1,000 rows per alarm, **checked before every chunk** (I-1), so one call can never exceed it; work left → re-arm for now. | §2.6 step 7 |
| P-5 | §4.4's end states cover a deferred notice; an immediate send that fails transiently, **throws** (CR-1), or whose request is **cut off** (R2-3) has no path. | A send-now claim is written to `claimed_notice`, folds included, in the same transaction that takes it out of `pending_notice` (due `now + noticeRetryDelayMs(1)`). The route then calls `settleClaim`: sent or a drop state clears it; transient (any throw from the send included) folds it back into the pending notice. If the route never settles, the alarm recovers the claim at its due time and sends it: a rare duplicate rather than a loss. Only a failure of `claimNotice` itself (the object unreachable) loses the event: there is nowhere else to keep it. | §4.4 G1, F1 |
| P-6 | §2.4/§2.6 DDL is "illustrative … not executed" (§8). | Added: `reports.rkey` (+ index); `held.subject_kind`; `class_day.suppressed`; `class_period`; `outbox.covers`; meta `held_n:<class>` (exact stored count — a `COUNT(*)` per insert timed out at 25,000 decoys); `UserSecurityDO.inflight_notice` (I-2) and `claimed_notice` (R2-3); index `held (subject_kind, subject)` so a forget never scans `held` (R2-1). | §8, §2.4, §2.6, §4.4 |
| P-7 | §4.4's alarm sends a deferred notice with no request in hand; `claimNotice` carries no user id. | `UserSecurityDO` stores `this.ctx.id.name` in a one-row `owner` table. If it is ever unknown, that is its own outcome (I-9): logged `account-notice: owner_unknown <kind>`, kept retrying until the owner is known or the notice's maximum age passes; never `dropped_account_gone`. | §4.1, §4.4 G2 |
| P-8 | §3.3's test seams do not stop a real alarm, set for an instant already past, racing a test's explicit clock. | Every Durable Object has an `armAt` seam; tests replace it (`quiet()`), including around claims (I-5). A pool `setupFiles` hook makes counting flush at once into no-op stubs before every test (without it, every request with a `security:` line waits 5 s and five rate-limit burst tests failed). | §3.3, §2.4 Clock |
| P-9 | The brief asks for each binding in the vitest miniflare config; the pool reads `wrangler.jsonc` itself (`configPath`, `apps/api/vitest.config.ts:95`; 0 hits for `LIMITER`/`USER_SECURITY` there, the same grep finds `HYPERDRIVE_FRESH`). | DO bindings and flags come through `configPath`; `miniflare.bindings` gets only the new secret `DEVICE_HASH_KEY` (PR 2). The web vitest is plain Node; its binding is pinned by a Node test of the real `wrangler.jsonc`. | brief; §2.2 item 4 |
| P-10 | §4.4 reads the address in a Durable Object, which has no `ExecutionContext`. | `withClient`'s `ctx` narrows to `Pick<ExecutionContext, "waitUntil">` (`apps/api/src/db/client.ts:105` is its only use). | §4.4 |
| P-11 | §2.2 item 4's cross-script binding is untyped by `wrangler types`. | The web `worker-configuration.d.ts` hand-adds `SECURITY_COUNTER: { getByName(name: string): SecurityCounterRpc }`. | §2.2 item 4 |
| P-12 | §2.6 does not say whether the admin listing refreshes a ref, and a held account row has no ref until a message names it. | The listing shows an existing ref without refreshing it, and mints one (never shows a user id) for an unnamed row. | §2.6 N6, R4 |
| P-13 | **PM ruling I-10.** §2.5's buffer counts `net` (reset-token) subjects against the `ip` cap, so a reset-token flood can push a stuffing /64 into overflow, against C1. | `MAX_SUBJECTS_PER_FLUSH` gains its own `net: 50`; the buffer classifies each increment's cap by its rule's subject. | §2.5, C1 |
| P-14 | **PM rulings I-3 and R2-2.** §4.1 has every key-less sign-in log `device_hash_key_missing`; §2.6 step 6 raises `config_fault` only while notices are on. | No per-sign-in line. Instead the ledger raises one `config_fault` per UTC day whenever `DEVICE_HASH_KEY` is absent, **whatever `ACCOUNT_NOTICES_ENABLED` says**: device recording runs from phase 1, and without the key it silently stops. PR 2's gate sets the key before merge. | §4.1, §2.6 step 6 |
| P-15 | **Audit M-6**, departures the first revision did not list. | (a) a `summarise` decision adds nothing to a ledger count: summary-class activity comes only from `site.summarise` (§2.6 `report()` says "add to the class's daily activity"); (b) the api's `clientCountry` falls back to `CF-IPCountry` (§4.2 names only `X-TJ-Client-Country`) so direct `worker.fetch` tests work; production traffic always arrives over the binding with the header set or deleted. | §2.6, §4.2 |
| P-17 | **PM ruling R2-1.** §4.5 accepts "log and continue" for the reapers' forget, but a lost forget is never retried (neither reaper selects the account again) and `held` rows keep a raw user id past what N7 allows. | Both reapers AWAIT their forgets after `withClient` returns (locks released), 50 at a time (a sequential loop pushed the existing SKIP LOCKED test past its 3 s window under full-suite load). A nightly sweep (`src/security/forget-sweep.ts`, from the existing `30 3 * * *` cron, PR 1) re-forgets every account anonymised in the last 3 days and every account id the ledger still holds whose user is anonymised or deleted (a deleted row leaves nothing to query, so the ledger's ids are reconciled against Postgres). Idempotent, bounded at 200 ids per step per run (the ledger's page cursor wraps), counts logged. It adds a fifth change to the pinned dispatcher, beyond §2.2's four. | §2.6 N7, m-e; §4.5 |
| P-16 | **Audit M-5.** Consecutive digests shared their boundary minute, and a late digest read pruned buckets. | `summarise` is half-open; the digest's period starts no earlier than the counter's retention (`COUNTER_RETENTION_MINUTES − 1`), so `periodStart` says exactly what was counted. | §2.6 step 5 |

## Review Focus — the five untested input classes most likely to bite

1. **Wall-clock time against the explicit clock.** Every Durable Object test drives `alarmAt(nowMs)`; production runs `alarm()` at real times: a UTC-day rollover between a report and its alarm (`class_day`, `held_overflow` and the heartbeat key on `utcDay`), an alarm that first runs days late, a large `meta.seq`.
2. **Two `Set-Cookie` headers.** Login, signup and reset append the device cookie after the session cookie. The web Worker forwards with `getSetCookie()` (`apps/web/src/lib/api.ts:234-237`), but a browser rejecting `__Host-tj_device` would silently mail on every sign-in; only PR 2's deployed check sees a real browser.
3. **Unparsed or hostile subjects.** `limiterIpKey` and `networkKey` return an unparsed value unchanged, so a strange IP becomes a subject string of any length in `buckets`, `held` and an admin cursor (`after` is capped at 512).
4. **Postmark answers the tests did not invent.** Pinned: 200/0, 422 with 300/406, 401 plain text, 503, a throw, a lookup that throws. A 2xx with a non-JSON body or a string `ErrorCode` falls to "transient" by construction; nothing pins it.
5. **Interleaving across RPCs.** Revision 2 pins the two races the audit found (a sign-in folded while the alarm awaits Postmark; a crossing merged while the counter awaits the ledger). Two flows for one account interleaving across their own RPCs (record A, record B, claim A, claim B) are still pinned only sequentially.

## Plan-time verification (what was actually run, revision 2)

All in scratch copies of `f3da62d` outside `C:\Projects`, with `node_modules` resolved read-only through directory junctions to the main checkout's installed packages and the in-repo `@thinkersjournal/shared` pointed at the scratch copy. Three states: **PR 1 alone** (its own tree), **PR 1 + 2** (the full tree with PR 3 taken out in place, then restored), and **all three PRs**.
- **tsc** (TypeScript 6.0.3): `packages/shared` (`-p .`), `apps/api` (`-p .`, `-p test/tsconfig.json`, `-p test/tsconfig.node.json`) and `apps/web` (a `tsc -p` over `worker-configuration.d.ts`, `src/lib/**/*.ts`, the purge and health `.ts` pages and the new or changed web tests; `.astro` is left to `astro check`). **Exit 0 in all three states.** Positive control: appending `export const probeCtl: number = "x";` to `SecurityLedgerDO.ts`, `UserSecurityDO.ts`, `security-buffer.ts` and `security-counting.ts` gave TS2322 in each and exit 2, in the PR 1 tree and the full tree; restored, exit 0.
- **Tests**, against scratch databases this plan created in revision 1 (no database was created in revision 2; they are dropped at the end): 
  - **All three PRs:** api **139 files, 1,918 tests, all passed** (`--exclude test/migrations.db.test.ts`, per the rule above); shared **19 files, 163 tests, all passed**; web 87 of 88 files (1,191 tests). The web failure is the scratch environment: `workers-cache.test.ts` reads `dist/utils/response.js` from the installed `@astrojs/cloudflare`, which the main checkout has at 14.1.3 (the repo pins 14.3.3); it fails the same way in the PR 1 tree, which does not touch it.
  - **PR 1 alone:** api **135 files, 1,864 tests, all passed**; shared 19 files, 150 tests, all passed; web 83 of 85 files, the same `workers-cache` failure plus `purge.test.ts`'s `timingSafeEqual` sweep, which runs `git grep` and the PR 1 scratch tree has no `.git` (it passes in the all-PRs tree, which has one).
  - The first revision-2 run failed the existing RF6 and SKIP LOCKED lock tests in the PR 1 tree (each read by name): the reaper hooks made Durable Object calls per row inside the locked loop. Task 13 now runs them after the loop, in `waitUntil`; both suites then passed in full. One run also timed out `dmca-phone-only-on-dmca-page.node.test.ts` (a disk walk under load); it passed alone and in the final run.
- **Revision 3:** tsc exit 0 again in all three states, with the same positive control (exit 2, then 0 restored). Affected tests and both full api suites re-run: the PR 1 tree's api suite **136 files, 1,866 tests, all passed**; the all-PRs tree **140 files, 1,921 tests**, all passed in one run and 1,920 in the next, whose one failure was `dmca-phone-only-on-dmca-page.node.test.ts` timing out its 5 s disk walk under load (the same test passed in the previous run of the same code, and alone); shared 163 tests passed. Along the way two existing lock tests (RF6, SKIP LOCKED) and the new sweep test each timed out once under full-suite load with sequential awaits; the forgets now run 50 at a time (`forgetAll`, `SWEEP_CONCURRENCY`), after which the three runs above were taken. Scratch databases only, dropped afterwards.
- **Mutation controls executed** (each applied, its test run, then restored; the restored run passes): R2-3's `writeClaimed` dropped → RED; R2-2's notices-flag condition restored → RED; R2-1's ledger reconcile skipped → RED; CR-1's catch made a rethrow → RED; `settle` also deleting `pending_notice` (the old delete-after-await) → RED; the counter's detach removed → RED; the old prune loop → RED (`perCall` = `[10500]`); the deliver step unwrapped → RED; a fifth backoff step (no drop at the 4th failure) → RED.
- **Confirmations answered in the pool** (miniflare; a deployed re-check still applies where noted): 2, 3 (now by a test that leaves `stubFor` at its default and finds the row in the real counter instance), 4 (tsc), 5's `Intl.DisplayNames` half, 7 and 8 (re-check deployed). Still open: 1, 5's header half, 6.

## Testing realities in this repo

- **Commands** (bash; PowerShell sets `$env:TEST_DATABASE_URL` first):
  - one api file: `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/thinkersjournal_test_appeals pnpm --filter @thinkersjournal/api test -- test/<file>.test.ts`
  - the api suite: `TEST_DATABASE_URL=…/thinkersjournal_test_appeals pnpm --filter @thinkersjournal/api test -- --exclude test/migrations.db.test.ts`
  - shared and web: `pnpm --filter @thinkersjournal/shared test`, `pnpm --filter @thinkersjournal/web test`; typecheck: `pnpm typecheck`.
  `global-setup.ts` applies the migrations to `TEST_DATABASE_URL`, so the PR 3 migration reaches `…_appeals` on its first run. Below, "`…/api test -- X`" always means the full command above with `TEST_DATABASE_URL` set.
- **The limiter-window helper** (`apps/api/test/helpers/limiter-window.ts:92`, `awaitLimiterBurstWindow`) is for a test that spends a limiter and asserts a 429. No test here asserts a 429; the existing burst tests keep working because of P-8's setup file. Any 429 test an implementer adds calls it immediately before the burst.
- **Lock-dependent tests** use the existing deterministic `pg_blocking_pids` choreography, never a sleep: `whileReaperWaits` and `waitUntilBlockedBy` in `apps/api/test/anonymise-accounts.test.ts:296-370`, serialised by `test/helpers/anonymise-reaper-lock.ts`. Task 13 uses it.
- **Durable Object alarms.** No existing test drives one: 0 hits for `alarm` in `apps/api/test` at `f3da62d` (the same grep shape finds `evictAllDurableObjects` in `test/user-security-do.test.ts:1`). This plan drives `alarmAt(nowMs)` through `runInDurableObject` (from `cloudflare:test`, first use here) with `armAt` replaced (P-8), and keeps one real-alarm test for the cron.
- **Global `fetch` stubs reach Durable Objects.** The pool runs them in the test's isolate, so `vi.stubGlobal("fetch", …)` (as in `test/forgot-password.test.ts:33-57`) also intercepts a notice sent from `UserSecurityDO`'s alarm.
- **The web suite is plain Node** (`apps/web/vitest.config.ts`): pages are tested structurally; `.astro` is type-checked by `pnpm --filter @thinkersjournal/web typecheck` (`astro check`).

## File structure

| File | PR | Responsibility |
|---|---|---|
| `packages/shared/src/security-log.ts` (modify) | 1 | Observer hook, counting argument, `alerting_fault` (§2.2). |
| `packages/shared/src/security-alert.ts` (create) | 1 | Signals, classes, messages, the sink seam (§3.2; P-3, I-8, I-11). |
| `packages/shared/src/security-signals.ts` (create) | 1 | The spec's §2.3 block as merged. |
| `packages/shared/src/security-buffer.ts` (create) | 1 | Per-isolate aggregation and flush (§2.5; P-13). |
| `packages/shared/src/security-ledger-policy.ts`, `security-ledger-types.ts` (create) | 1 | §2.6 policy; P-1 shapes. |
| `packages/shared/src/account-notices.ts` (create; replaced in PR 2) | 1, 2 | PR 1: `PostmarkOutcome`, `classifyPostmark`. PR 2: all of §4.1–§4.2. |
| `packages/shared/src/security-admin.ts` (create) | 3 | Admin response types. |
| `apps/api/src/durable-objects/SecurityCounterDO.ts` (create) | 1 | Counting, members, reports (detached while sent), retention (§2.4). |
| `apps/api/src/durable-objects/SecurityLedgerDO.ts` (create; extended in 2, 3) | 1–3 | Decisions, held subjects, refs, forget + tombstone, the alarm's seven steps. |
| `apps/api/src/security/{counter-schema,ledger-schema,ledger-store,ledger-held,ledger-messages,ledger-prune,ledger-cron,scope,forget,forget-sweep}.ts` (create) | 1 | The two classes' modules; the request scope; the cron hook; the reapers' clean-up (PR 2 extends `forget.ts`) and the nightly sweep (P-17). |
| `apps/api/src/auth/{anonymise-accounts,reap-unverified}.ts` (modify) | 1 | The reaper hooks (N7, moved to PR 1 by I-11). |
| `apps/api/src/security/{device-cookie,user-devices,account-notice-send,account-notices-flow}.ts` (create) | 2 | Cookie, device list and notice tables, notice text and send, the login/reset flow. |
| `apps/api/src/durable-objects/UserSecurityDO.ts` (modify) | 2 | Device tables, caps, pending and in-flight notice, alarm. |
| `apps/api/src/index.ts`, `routes/login.ts` (modify) | 1, 2 | The named pin changes; login counting (PR 1), device wiring (PR 2). |
| `apps/api/src/routes/{signup,reset-password}.ts`, `db/client.ts` (modify) | 2 | Device wiring; P-10. |
| `apps/api/src/auth/postmark.ts` (modify) | 1 | `postmarkSendOutcome`; `postmarkSend` its boolean view. |
| `apps/api/src/security/ledger-admin.ts`, `routes/{admin-security,health-security-ledger}.ts`, `routes.ts`, `moderation/actions.ts` | 3 | Ref resolution, held listing, two admin GETs, the health GET, the new action kind. |
| `apps/api/migrations/NNNN_security_ref_resolved.sql` (create) | 3 | `security_ref_resolved` in the CHECK list; `NNNN` is allocated by the PM when PR 3 opens. |
| `apps/api/wrangler.jsonc`, `src/worker-configuration.d.ts`, `vitest.config.ts`, `test/setup/security-counting.ts` | 1, 2 | Bindings, `v4`, vars; Env lines; P-8/P-9. |
| `apps/web/…` (purge, counting, client-ip-store and its five call sites, cache, health page, admin page) | 1–3 | Purge counting; country header; health page; admin page. |
| `docs/superpowers/specs/2026-10-07-security-alerting-design.md` (modify) | 1 | One-line amendment: `distinctPrefixes` dropped (I-8). |
| `docs/runbooks/deploy.md` (modify) | 1, 2, 3 | The flags (PR 1); `DEVICE_HASH_KEY` setup and rotation (PR 2, I-3/I-4); health (PR 3). |

---

# PR 1 — counting, the ledger, the seam (Tasks 1–14)

Branch from `main`. Everything here ships dark except counting itself (`SECURITY_COUNTING="on"`), whose only outlet is the log sink. Its messages carry refs and counts, never a link (I-11).

### Task 1: The observer in `logSecurityEvent`

**Files:** modify `packages/shared/src/security-log.ts`; create `packages/shared/test/security-log.test.ts`.

**Produces** (§2.2 item 1, verbatim): `SecurityEventKind` (+ `"alerting_fault"`), `SecurityEvent`, `SecurityEventCounting`, `SecurityEventObserver`, `setSecurityEventObserver(next: SecurityEventObserver | null): void`, `logSecurityEvent(event: SecurityEvent, counting?: SecurityEventCounting): void`.

- [ ] **Step 1: RED.** Create the test. It fails on `setSecurityEventObserver` not existing.

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { logSecurityEvent, setSecurityEventObserver } from "../src/security-log";

import type { SecurityEvent, SecurityEventCounting } from "../src/security-log";

const EVENT: SecurityEvent = { kind: "auth_failure", route: "/auth/login", reason: "invalid_credentials", ip: "203.0.113.9" };
const ADDRESS = "fixture-person@example.invalid";

afterEach(() => {
  setSecurityEventObserver(null);
  vi.restoreAllMocks();
});

describe("logSecurityEvent (security-alerting spec §2.2)", () => {
  it("writes the SAME line as before, byte for byte", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logSecurityEvent(EVENT);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("security: auth_failure /auth/login invalid_credentials");
    expect(Object.keys(warn.mock.calls[0]?.[1] as object)).toEqual(["kind", "route", "reason", "ip", "at"]);
  });

  it("calls the observer once per event, with the counting argument and the line's own time", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen: [SecurityEvent, Date, SecurityEventCounting][] = [];
    setSecurityEventObserver((e, at, c) => seen.push([e, at, c]));
    logSecurityEvent(EVENT, { email: ADDRESS, userId: "u1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[2]).toEqual({ email: ADDRESS, userId: "u1" });
  });

  it("never puts the counting argument into the log (positive control: the observer got it)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const got: string[] = [];
    setSecurityEventObserver((_e, _at, c) => got.push(c.email ?? ""));
    logSecurityEvent(EVENT, { email: ADDRESS, userId: "user-id-fixture" });
    expect(got).toEqual([ADDRESS]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(ADDRESS);
    expect(logged).not.toContain("user-id-fixture");
  });

  it("an observer that throws neither throws out nor stops the line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setSecurityEventObserver(() => {
      throw new Error("observer broke");
    });
    expect(() => logSecurityEvent(EVENT)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an `alerting_fault` line uses the same prefix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logSecurityEvent({ kind: "alerting_fault", route: "security-ledger", reason: "ledger_unreachable", ip: null });
    expect(warn.mock.calls[0]?.[0]).toBe("security: alerting_fault security-ledger ledger_unreachable");
  });
});
```

- [ ] **Step 2: Implement.** Replace the file with the header comment below (it rewrites `:6-9`, which said the follow-up "counts these lines out of Cloudflare's Workers Logs"; §1.2 says why it does not), then the spec's §2.2 item 1 `ts` block verbatim.

```ts
/**
 * One log shape for every security-relevant refusal, on BOTH Workers: a failed
 * authentication (wrong password, bad reset token, wrong purge secret) and every
 * rate-limit 429 on the routes that carry one.
 *
 * ⚠️ THE `security:` PREFIX IS A CONTRACT, NOT DECORATION. Operators query
 * Cloudflare's Workers Logs for it (`observability.enabled` on both Workers). The
 * alerting pipeline does NOT read the logs: it counts in-process, through the
 * observer below, because the line carries no address and no user id and the
 * stuffing and targeted-account signals need both (security-alerting spec §1.2).
 * Do not reword the prefix, and do not log a security event any other way.
 *
 * ⚠️ NEVER PASS A SECRET. The fields are fixed on purpose: a route, a short
 * machine-readable reason, the client IP and a timestamp. A password, a reset
 * token, a purge secret, a CSRF token or a limiter KEY (login's keys embed the
 * email address) has no field to go in. Cloudflare's log retention is not ours to
 * scrub. The second argument (`SecurityEventCounting`) goes to the observer
 * ONLY, never to `console`.
 *
 * `console.warn`, not `console.error`: a refusal is the system WORKING. The level
 * still lands in Workers Logs, and keeps these out of the error-rate signal.
 */
/**
 * `alerting_fault` is the alerting pipeline reporting on itself (an unreachable
 * ledger, a missing key, §2.4 and §4.1), so a query for `security:` finds it.
 * The `security:` lines are therefore not all attacks: a query that counts
 * attacks filters on `auth_failure` and `rate_limited`. The observer may see an
 * `alerting_fault` (the missing-key line is logged inside a request's
 * `waitUntil`), but no rule matches it, and `missing_client_ip` excludes it.
 */
export type SecurityEventKind = "auth_failure" | "rate_limited" | "alerting_fault";

export interface SecurityEvent {
  kind: SecurityEventKind;
  /** The route path, e.g. `/auth/login`. */
  route: string;
  /** A short machine-readable cause, e.g. `invalid_credentials`, `ip`, `ip:email`. */
  reason: string;
  /** The client IP as the Worker resolved it, or null when it had none. */
  ip: string | null;
}

/**
 * What the COUNTER may know about an event that the LOG must never carry.
 * Handed to the observer only; never written to `console`.
 */
export interface SecurityEventCounting {
  /** The lowercased address a login attempt named (distinct-email counting). */
  readonly email?: string;
  /** The account the attempt resolved to, when one exists (per-account counting). */
  readonly userId?: string;
}

/** Called once per event, after the log line. Must not throw; a throw is swallowed. */
export type SecurityEventObserver = (event: SecurityEvent, at: Date, counting: SecurityEventCounting) => void;

let observer: SecurityEventObserver | null = null;

/** Installed once at module scope by a Worker's entry module; null uninstalls (tests). */
export function setSecurityEventObserver(next: SecurityEventObserver | null): void {
  observer = next;
}

/** Write one `security:` line, then tell the observer. Returns nothing and never throws. */
export function logSecurityEvent(event: SecurityEvent, counting: SecurityEventCounting = {}): void {
  const at = new Date();
  try {
    console.warn(`security: ${event.kind} ${event.route} ${event.reason}`, {
      kind: event.kind,
      route: event.route,
      reason: event.reason,
      ip: event.ip,
      at: at.toISOString(),
    });
  } catch {
    // A logging failure must never turn a refusal into a 500.
  }
  try {
    observer?.(event, at, counting);
  } catch {
    // Nor may a counting failure.
  }
}
```

- [ ] **Step 3: GREEN.** `pnpm --filter @thinkersjournal/shared test -- test/security-log.test.ts`. Mutation control: delete the `try` around `observer?.(…)`; "an observer that throws" goes RED; restore.

### Task 2: The seam and the message types (`security-alert.ts`), and the spec amendment

**Files:** create `packages/shared/src/security-alert.ts`, `packages/shared/test/security-alert.test.ts`; modify the spec (one line).

**Produces** (§3.2, plus P-3, I-8, I-11): `SecurityAlertSignal`, `SignalClass`, `SecurityAlertSubject`, the eight message interfaces and `SecurityAlertMessage`, `SecurityAlertDelivery`, `SecurityAlertSink`, `LogSecurityAlertSink`, `SecurityAlertEnv`, `SecurityAlertTransportFactory`, `selectSecurityAlertSink(env, transport)`, `deliverSecurityAlert(sink, message, timeoutMs = 10_000)`.

- [ ] **Step 1: RED.** (§5's "No PII in messages" is pinned on the ledger's real output, Task 9; a test over hand-written literals would test nothing.)

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deliverSecurityAlert,
  LogSecurityAlertSink,
  selectSecurityAlertSink,
  type SecurityAlertMessage,
  type SecurityAlertSink,
} from "../src/security-alert";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SECRET_EMAIL = "alerts-fixture@example.invalid";
const SECRET_TOKEN = "relay-token-fixture-0000";
const fakeSink: SecurityAlertSink = { name: "fake", send: async () => ({ delivered: true }) };

describe("selectSecurityAlertSink (security-alerting spec §3.2)", () => {
  it("flag off → the log sink, whatever is configured", () => {
    const sink = selectSecurityAlertSink({ SECURITY_ALERTS_ENABLED: "0", SECURITY_ALERT_EMAIL: SECRET_EMAIL }, () => fakeSink);
    expect(sink).toBeInstanceOf(LogSecurityAlertSink);
  });

  it("flag on, factory present, address empty → the log sink, LOUDLY, naming the key and no value", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { SECURITY_ALERTS_ENABLED: "1", SECURITY_ALERT_EMAIL: "", SECURITY_ALERT_RELAY_TOKEN: SECRET_TOKEN };
    expect(selectSecurityAlertSink(env, () => fakeSink)).toBeInstanceOf(LogSecurityAlertSink);
    expect(err).toHaveBeenCalledWith(expect.any(String), { missing: ["SECURITY_ALERT_EMAIL"] });
    expect(JSON.stringify(err.mock.calls)).not.toContain(SECRET_TOKEN);
  });

  it("flag on and the transport is still null (phase 1) → the log sink, naming `transport`", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { SECURITY_ALERTS_ENABLED: "1", SECURITY_ALERT_EMAIL: SECRET_EMAIL, SECURITY_ALERT_RELAY_TOKEN: SECRET_TOKEN };
    expect(selectSecurityAlertSink(env, null)).toBeInstanceOf(LogSecurityAlertSink);
    expect(err).toHaveBeenCalledWith(expect.any(String), { missing: ["transport"] });
  });

  it("fully configured → the factory's sink", () => {
    const env = { SECURITY_ALERTS_ENABLED: "1", SECURITY_ALERT_EMAIL: SECRET_EMAIL, SECURITY_ALERT_RELAY_TOKEN: SECRET_TOKEN };
    expect(selectSecurityAlertSink(env, () => fakeSink)).toBe(fakeSink);
  });
});

describe("deliverSecurityAlert", () => {
  const msg: SecurityAlertMessage = { type: "config_fault", key: "DEVICE_HASH_KEY", detail: "missing" };

  it("a throwing sink → delivered: false, never a throw", async () => {
    const sink: SecurityAlertSink = {
      name: "t",
      send: async () => {
        throw new TypeError("boom");
      },
    };
    expect(await deliverSecurityAlert(sink, msg)).toEqual({ delivered: false, reason: "TypeError" });
  });

  it("a sink that never resolves → `timeout` after 10 s (fake timers)", async () => {
    vi.useFakeTimers();
    const sink: SecurityAlertSink = { name: "hang", send: () => new Promise(() => undefined) };
    const pending = deliverSecurityAlert(sink, msg);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ delivered: false, reason: "timeout" });
  });
});

describe("LogSecurityAlertSink", () => {
  it("writes one `security-alert:` line — never the `security:` prefix", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await new LogSecurityAlertSink().send({ type: "heartbeat", day: "2026-10-07", lateMinutes: 0, totals: [] })).toEqual({
      delivered: true,
    });
    expect(warn.mock.calls[0]?.[0]).toBe("security-alert: heartbeat");
    expect(String(warn.mock.calls[0]?.[0]).startsWith("security:")).toBe(false);
  });
});

// §5's "No PII in messages" is pinned on the ledger's REAL output (test/security-ledger-do.test.ts),
// not on hand-written literals here, which would test nothing (audit I-7).
```

- [ ] **Step 2: Implement.** The spec's §3.2 `ts` block, with exactly this diff:

```diff
--- spec block
+++ b/packages/shared/src/security-alert.ts
@@ -69,6 +69,16 @@
   /** Held subjects not yet covered by a delivered held-subject report. */
   readonly heldOpen: number;
-  /** Summary classes: events and distinct /64s in the period, by signal. */
-  readonly activity: Readonly<Record<string, { readonly events: number; readonly distinctPrefixes: number }>>;
+  /**
+   * Plan ruling P-3: subjects the row cap made the ledger COUNT instead of
+   * store, today (§2.6 F3: "every digest and held-subject report carries the counts").
+   */
+  readonly heldCountedNotStored: number;
+  /**
+   * Summary classes: events in the period, by signal. Plan ruling I-8 (PM):
+   * `distinctPrefixes` is dropped — §2.3's `classify` collects no members for
+   * summary rules, and any capped collection would report a silently truncated
+   * count. Thresholds are on events, so no signal is lost (spec amended in PR 1).
+   */
+  readonly activity: Readonly<Record<string, { readonly events: number }>>;
 }
 
@@ -85,4 +95,10 @@
   /** True when the site counter could not be read for `activity`. */
   readonly siteSummaryUnavailable: boolean;
+  /**
+   * Plan ruling P-3: deferred account notices that ended in a Postmark drop
+   * state since the last digest. The first of each state per day also sends
+   * `notice_dropped`; the rest are counted here (§4.4).
+   */
+  readonly noticesDropped: Readonly<Record<SecurityNoticeDropped["endState"], number>>;
 }
 
@@ -108,6 +124,11 @@
   /** Past the cap: how many more per class, all listed on the admin page. */
   readonly more: readonly { readonly signalClass: SignalClass; readonly count: number }[];
-  /** The admin page that pages through the full held list. */
-  readonly adminUrl: string;
+  /**
+   * The admin page that pages through the full held list. Plan ruling I-11
+   * (PM): null until that page ships (PR 3), so no shipped message links to a 404.
+   */
+  readonly adminUrl: string | null;
+  /** Plan ruling P-3: per class, subjects counted but not stored today (not on the admin page either). */
+  readonly countedNotStored: readonly { readonly signalClass: SignalClass; readonly count: number }[];
 }
 
```

and the spec gains one line (PM ruling I-8):

````diff
--- a/docs/superpowers/specs/2026-10-07-security-alerting-design.md
+++ b/docs/superpowers/specs/2026-10-07-security-alerting-design.md
@@ -1351,6 +1351,8 @@
   }
 }
 ```
+
+**Amendment (implementation plan, PR 1; PM ruling I-8):** `DigestClassLine.activity` carries `events` only; `distinctPrefixes` is dropped, because §2.3's `classify` collects no members for summary rules and a capped collection would report a silently truncated count. Every threshold is on events, so no signal is lost.
 
 **Payload minimisation (I7).**
 - **No user id, ever.** An account appears as an opaque ref an admin can resolve (§2.6).
````

- [ ] **Step 3: GREEN.** `pnpm --filter @thinkersjournal/shared test -- test/security-alert.test.ts`.

### Task 3: Classification (`security-signals.ts`)

**Files:** create `packages/shared/src/security-signals.ts`, `packages/shared/test/security-signals.test.ts`.

**Consumes:** `limiterIpKey` (`packages/shared/src/limiter-ip-key.ts:24`). **Produces** (§2.3): `SubjectKind`, `Measure`, `SignalRule`, `SIGNAL_RULES`, `SHARDS_PER_KIND`, `CounterIncrement`, `shardFor(kind, subject)`, `networkKey(ip)`, `classify(event, at, counting): CounterIncrement[]`.

- [ ] **Step 1: RED.** (Tasks 3–5 import each other; write all three tests first, then the modules.)

```ts
import { describe, expect, it } from "vitest";

import { classify, networkKey, shardFor, SHARDS_PER_KIND, SIGNAL_RULES } from "../src/security-signals";

import type { SecurityEvent } from "../src/security-log";

const AT = new Date("2026-10-07T12:00:30.000Z");
const MINUTE = Math.floor(AT.getTime() / 60_000);
const loginFail = (ip: string | null): SecurityEvent => ({
  kind: "auth_failure",
  route: "/auth/login",
  reason: "invalid_credentials",
  ip,
});
const signals = (e: SecurityEvent, c = {}) => classify(e, AT, c).map((i) => i.signal).sort();

describe("classify (security-alerting spec §2.3)", () => {
  it("a login failure with an account yields exactly six increments, by name", () => {
    expect(signals(loginFail("203.0.113.9"), { email: "a@example.invalid", userId: "u1" })).toEqual([
      "credential_stuffing",
      "distributed_account_guess",
      "login_failure_storm",
      "login_ip_burst",
      "slow_stuffing",
      "targeted_account",
    ]);
  });

  it("without an account: four", () => {
    expect(signals(loginFail("203.0.113.9"), { email: "a@example.invalid" })).toEqual([
      "credential_stuffing",
      "login_failure_storm",
      "login_ip_burst",
      "slow_stuffing",
    ]);
  });

  it("a login 429 yields ONLY rate_limit_storm — no per-/64 row (control: the failure above yields login_ip_burst)", () => {
    const e: SecurityEvent = { kind: "rate_limited", route: "/auth/login", reason: "ip", ip: "2001:db8:1:2::9" };
    expect(signals(e)).toEqual(["rate_limit_storm"]);
    expect(signals(loginFail("2001:db8:1:2::9"))).toContain("login_ip_burst");
  });

  it("a user-keyed 429 yields exactly one increment", () => {
    const e: SecurityEvent = { kind: "rate_limited", route: "/comments", reason: "user", ip: "203.0.113.9" };
    expect(signals(e)).toEqual(["rate_limit_storm"]);
  });

  it("two IPv6 addresses in one /64 share a subject and a shard; another /64 does not", () => {
    const sub = (ip: string) => classify(loginFail(ip), AT, {}).find((i) => i.signal === "login_ip_burst");
    const a = sub("2001:db8:1:2::1");
    const b = sub("2001:db8:1:2:ffff::9");
    const c = sub("2001:db8:1:3::1");
    expect(a?.subject).toBe("2001:db8:1:2::/64");
    expect(b?.subject).toBe(a?.subject);
    expect(b?.shard).toBe(a?.shard);
    expect(c?.subject).not.toBe(a?.subject);
  });

  it("an IPv4-mapped address is its IPv4 subject", () => {
    const sub = (ip: string) => classify(loginFail(ip), AT, {}).find((i) => i.signal === "login_ip_burst")?.subject;
    expect(sub("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("reset_token_burst counts per /48 and per /24 (control: login_ip_burst gives two subjects)", () => {
    const reset = (ip: string): SecurityEvent => ({ kind: "auth_failure", route: "/auth/reset-password", reason: "invalid_reset_token", ip });
    const net = (ip: string) => classify(reset(ip), AT, {}).find((i) => i.signal === "reset_token_burst")?.subject;
    expect(net("2001:db8:1:2::1")).toBe("2001:db8:1::/48");
    expect(net("2001:db8:1:7::1")).toBe("2001:db8:1::/48");
    expect(net("203.0.113.9")).toBe("203.0.113.0/24");
    expect(net("203.0.113.200")).toBe("203.0.113.0/24");
    expect(net("::ffff:203.0.113.9")).toBe("203.0.113.0/24");
    expect(networkKey("300.1.1.1")).toBe("300.1.1.1");
    const burst = (ip: string) => classify(loginFail(ip), AT, {}).find((i) => i.signal === "login_ip_burst")?.subject;
    expect(burst("203.0.113.9")).not.toBe(burst("203.0.113.200"));
  });

  it("ip: null → subject `none` and missing_client_ip, except purge and alerting_fault", () => {
    expect(classify(loginFail(null), AT, {}).find((i) => i.signal === "login_ip_burst")?.subject).toBe("none");
    expect(signals(loginFail(null))).toContain("missing_client_ip");
    const purge: SecurityEvent = { kind: "auth_failure", route: "/internal/purge", reason: "bad_purge_secret", ip: null };
    expect(signals(purge)).toEqual(["purge_secret_failure"]);
    const fault: SecurityEvent = { kind: "alerting_fault", route: "/auth/login", reason: "device_hash_key_missing", ip: null };
    expect(signals(fault)).toEqual([]);
  });

  it("shardFor always returns one of the 33 names", () => {
    const names = new Set(["site", ...Array.from({ length: SHARDS_PER_KIND }, (_, i) => [`ip:${i}`, `acct:${i}`]).flat()]);
    expect(names.size).toBe(33);
    for (let i = 0; i < 500; i++) {
      expect(names.has(shardFor("ip", `2001:db8:${i}::/64`))).toBe(true);
      expect(names.has(shardFor("account", `user-${i}`))).toBe(true);
    }
  });

  it("every increment is stamped with the event's minute", () => {
    for (const inc of classify(loginFail("203.0.113.9"), AT, { email: "a@example.invalid" })) expect(inc.minute).toBe(MINUTE);
  });

  it("events rules carry no member (the spec's classify, as merged; ruling I-8)", () => {
    for (const inc of classify(loginFail("2001:db8:1:2::9"), AT, {})) expect(inc.member, inc.signal).toBeNull();
  });

  it.each(SIGNAL_RULES.map((r) => [r.signal, r] as const))("%s matches its own event and not a control", (_s, rule) => {
    const route = rule.signal.startsWith("reset") ? "/auth/reset-password" : rule.signal === "purge_secret_failure" ? "/internal/purge" : "/auth/login";
    const kind = rule.signal === "rate_limit_storm" ? "rate_limited" : "auth_failure";
    const ip = rule.signal === "missing_client_ip" ? null : "203.0.113.9";
    const hit: SecurityEvent = { kind, route, reason: "x", ip };
    expect(rule.matches(hit, { email: "a@example.invalid", userId: "u1" })).toBe(true);
    const control: SecurityEvent = { kind: "alerting_fault", route: "/elsewhere", reason: "x", ip: "203.0.113.9" };
    expect(rule.matches(control, {})).toBe(false);
  });
});
```

- [ ] **Step 2: Implement:** the spec's §2.3 `ts` block, as merged (I-8 reversed the first revision's addition).

The file is the spec block exactly (checked byte for byte, LF, when this plan was generated).

- [ ] **Step 3: GREEN** after Task 5's module exists.

### Task 4: The per-isolate buffer (`security-buffer.ts`)

**Files:** create `packages/shared/src/security-buffer.ts`, `packages/shared/test/security-buffer.test.ts`.

**Produces** (§2.5, plus P-13): `CounterRow`, `CounterBatch`, `SecurityCounterRpc`, `SecurityRequestScope`, `FLUSH_DELAY_MS`, `MAX_SUBJECTS_PER_FLUSH = { ip: 50, net: 50, acct: 200 }`, `MAX_MEMBERS_PER_ROW`, `class SecurityEventBuffer { constructor(sleep?); add(event, at, counting, scope): void; flush(scope): Promise<void> }`.

- [ ] **Step 1: RED.** (The caps are asserted as literals, so changing a constant cannot keep its test green, M-8.)

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecurityEventBuffer } from "../src/security-buffer";

import type { CounterBatch, SecurityRequestScope } from "../src/security-buffer";
import type { SecurityEvent } from "../src/security-log";

const AT = new Date("2026-10-07T12:00:00.000Z");

/** A fake scope: records every `record` call by shard, and every waitUntil promise. */
function fakeScope(reject = false) {
  const calls: { shard: string; batch: CounterBatch }[] = [];
  const pending: Promise<unknown>[] = [];
  const scope: SecurityRequestScope = {
    waitUntil: (p) => {
      pending.push(p);
    },
    stubFor: (shard) => ({
      record: async (batch) => {
        calls.push({ shard, batch });
        if (reject) throw new Error("record failed");
      },
    }),
  };
  return { scope, calls, pending };
}

/** A `sleep` the test releases by hand: no wall clock anywhere. */
function manualSleep() {
  let release: () => void = () => undefined;
  const sleep = () =>
    new Promise<void>((r) => {
      release = r;
    });
  return { sleep, release: () => release() };
}

const loginFail = (ip: string): SecurityEvent => ({ kind: "auth_failure", route: "/auth/login", reason: "invalid_credentials", ip });

afterEach(() => vi.restoreAllMocks());

describe("SecurityEventBuffer (security-alerting spec §2.5)", () => {
  it("100 user-keyed 429s → no record until sleep resolves, then ONE record to `site` with n = 100", async () => {
    const { sleep, release } = manualSleep();
    const buffer = new SecurityEventBuffer(sleep);
    const { scope, calls, pending } = fakeScope();
    const e: SecurityEvent = { kind: "rate_limited", route: "/comments", reason: "user", ip: "203.0.113.9" };
    for (let i = 0; i < 100; i++) buffer.add(e, AT, {}, scope);
    expect(calls).toHaveLength(0);
    expect(pending).toHaveLength(1);
    release();
    await Promise.all(pending);
    expect(calls.map((c) => c.shard)).toEqual(["site"]);
    expect(calls[0]?.batch.rows.map((r) => r.n)).toEqual([100]);
  });

  it("60 failures from 60 /64s → 50 /64 subjects; the other 10 events' 20 ip increments become overflow on `site`", async () => {
    const { sleep, release } = manualSleep();
    const buffer = new SecurityEventBuffer(sleep);
    const { scope, calls, pending } = fakeScope();
    for (let i = 0; i < 60; i++) buffer.add(loginFail(`2001:db8:${i.toString(16)}::1`), AT, { email: `p${i}@example.invalid` }, scope);
    release();
    await Promise.all(pending);
    const ipSubjects = new Set(calls.filter((c) => c.shard.startsWith("ip:")).flatMap((c) => c.batch.rows.map((r) => r.subject)));
    expect(ipSubjects.size).toBe(50); // a literal: the test must not move with the constant (M-8)
    const site = calls.find((c) => c.shard === "site");
    expect(site?.batch.overflowEvents).toBe(20);
    const storm = site?.batch.rows.find((r) => r.signal === "login_failure_storm");
    expect(storm?.n).toBe(60);
  });

  it("300 account failures across 300 accounts → accounts capped at 200, independently of the /64 cap", async () => {
    const { sleep, release } = manualSleep();
    const buffer = new SecurityEventBuffer(sleep);
    const { scope, calls, pending } = fakeScope();
    for (let i = 0; i < 300; i++) {
      buffer.add(loginFail(`2001:db8:${(i % 60).toString(16)}::1`), AT, { email: `p${i}@example.invalid`, userId: `u${i}` }, scope);
    }
    release();
    await Promise.all(pending);
    const accounts = new Set(calls.filter((c) => c.shard.startsWith("acct:")).flatMap((c) => c.batch.rows.map((r) => r.subject)));
    expect(accounts.size).toBe(200);
    const ips = new Set(calls.filter((c) => c.shard.startsWith("ip:")).flatMap((c) => c.batch.rows.map((r) => r.subject)));
    expect(ips.size).toBe(50);
  });

  it("I-10: a reset-token flood from 60 networks never pushes a stuffing /64 into overflow (its own cap)", async () => {
    const { sleep, release } = manualSleep();
    const buffer = new SecurityEventBuffer(sleep);
    const { scope, calls, pending } = fakeScope();
    for (let i = 0; i < 60; i++) {
      const e: SecurityEvent = { kind: "auth_failure", route: "/auth/reset-password", reason: "invalid_reset_token", ip: `198.51.${i}.7` };
      buffer.add(e, AT, {}, scope);
    }
    buffer.add(loginFail("2001:db8:aa:1::9"), AT, { email: "p@example.invalid" }, scope);
    release();
    await Promise.all(pending);
    const rows = calls.filter((c) => c.shard.startsWith("ip:")).flatMap((c) => c.batch.rows);
    expect(rows.some((r) => r.signal === "credential_stuffing" && r.subject === "2001:db8:aa:1::/64")).toBe(true);
    expect(new Set(rows.filter((r) => r.signal === "reset_token_burst").map((r) => r.subject)).size).toBe(50);
    expect(calls.find((c) => c.shard === "site")?.batch.overflowEvents).toBe(10);
  });

  it("a record that rejects → one count-only console.error, and flush resolves", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { sleep, release } = manualSleep();
    const buffer = new SecurityEventBuffer(sleep);
    const { scope, pending } = fakeScope(true);
    buffer.add(loginFail("203.0.113.9"), AT, { email: "p@example.invalid", userId: "u1" }, scope);
    release();
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]?.[1]).toEqual({ failed: expect.any(Number), of: expect.any(Number) });
    expect(JSON.stringify(err.mock.calls)).not.toContain("203.0.113.9");
  });
});
```

- [ ] **Step 2: Implement:** the spec's §2.5 `ts` block, with P-13's own `net` cap — exactly this diff:

```diff
--- spec block
+++ b/packages/shared/src/security-buffer.ts
@@ -1,3 +1,3 @@
-import { classify } from "./security-signals";
+import { classify, SIGNAL_RULES } from "./security-signals";
 import type { CounterIncrement } from "./security-signals";
 import type { SecurityAlertSignal } from "./security-alert";
@@ -38,6 +38,19 @@
  * Distinct subjects per flush, per kind; increments for further subjects become
  * `overflowEvents`. Separate caps, so /64 rotation cannot crowd out accounts.
+ * Plan ruling I-10 (PM): `net` (reset-token networks) has its OWN cap, so a
+ * reset-token flood (class ip_burst) can never push a stuffing /64 (class
+ * stuffing) into overflow — the C1 rule. They still share the `ip:` shards.
  */
-export const MAX_SUBJECTS_PER_FLUSH = { ip: 50, acct: 200 } as const;
+export const MAX_SUBJECTS_PER_FLUSH = { ip: 50, net: 50, acct: 200 } as const;
+
+type CapKind = keyof typeof MAX_SUBJECTS_PER_FLUSH;
+
+/** Signals whose subject is a network (§2.3 `SubjectKind` "net"). */
+const NET_SIGNALS: ReadonlySet<string> = new Set(SIGNAL_RULES.filter((r) => r.subject === "net").map((r) => r.signal));
+
+function capKindOf(inc: CounterIncrement): CapKind {
+  if (inc.shard.startsWith("acct:")) return "acct";
+  return NET_SIGNALS.has(inc.signal) ? "net" : "ip";
+}
 /** Distinct members kept per row: 2 × the largest distinct threshold (slow_stuffing, 150). */
 export const MAX_MEMBERS_PER_ROW = 300;
@@ -58,5 +71,5 @@
 export class SecurityEventBuffer {
   private rows = new Map<string, MutableRow>();
-  private subjects = { ip: new Set<string>(), acct: new Set<string>() };
+  private subjects = { ip: new Set<string>(), net: new Set<string>(), acct: new Set<string>() };
   private overflow = 0;
   private timerArmed = false;
@@ -80,5 +93,5 @@
   private addOne(inc: CounterIncrement): void {
     if (inc.shard !== "site") {
-      const kind = inc.shard.startsWith("ip:") ? "ip" : "acct";
+      const kind = capKindOf(inc);
       const seen = this.subjects[kind];
       if (!seen.has(inc.subject)) {
@@ -110,5 +123,5 @@
     const overflowEvents = this.overflow;
     this.rows = new Map();
-    this.subjects = { ip: new Set<string>(), acct: new Set<string>() };
+    this.subjects = { ip: new Set<string>(), net: new Set<string>(), acct: new Set<string>() };
     this.overflow = 0;
     const byShard = new Map<string, CounterRow[]>();
```

- [ ] **Step 3: GREEN.** Mutation controls: (a) change `MAX_SUBJECTS_PER_FLUSH.ip` to 51 — the 60-/64s test goes RED; (b) make `capKindOf` return `"ip"` for `net` signals — the I-10 test goes RED; restore both.

### Task 5: Ledger policy and the counter→ledger shapes

**Files:** create `packages/shared/src/security-ledger-policy.ts`, `packages/shared/src/security-ledger-types.ts`, `packages/shared/test/security-ledger-policy.test.ts`; modify `packages/shared/src/index.ts`.

**Produces:** (§2.6, verbatim) `ClassPolicy`, `CLASS_POLICY`, `LedgerState`, `LedgerAction`, `decide(signalClass, s)`, `HELD_ROW_CAP`, `dailyMessageCeiling()`, `HELD_PRIORITY`, `HELD_PAGE_SIZE`, `HELD_REPORT_BYTE_CAP`, `HeldReportBuilder`; (P-1) `CounterReport`, `LedgerReportBatch`, `SecurityLedgerReportRpc`, `SignalActivity { events }`, `SiteSummary`, `SiteSummaryRpc`.

- [ ] **Step 1: RED.** (The decoy test now spends purge, storm and ip_burst, M-8.)

```ts
import { describe, expect, it } from "vitest";

import {
  CLASS_POLICY,
  dailyMessageCeiling,
  decide,
  HeldReportBuilder,
  type LedgerState,
} from "../src/security-ledger-policy";
import { SIGNAL_RULES } from "../src/security-signals";

import type { SignalClass } from "../src/security-alert";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const fresh: LedgerState = {
  nowMs: NOW,
  cooldownUntilMs: null,
  onsetSentToday: false,
  classSentToday: 0,
  exhaustedQueuedToday: false,
};

/** Drive `decide` the way the ledger does, for one (signal, subject), `n` crossings an hour apart. */
function run(signalClass: SignalClass, n: number): string[] {
  let s = fresh;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const now = NOW + i * 3_600_000;
    const a = decide(signalClass, { ...s, nowMs: now });
    out.push(a.action);
    if (a.action === "send") s = { ...s, nowMs: now, cooldownUntilMs: a.cooldownUntilMs, onsetSentToday: true, classSentToday: s.classSentToday + 1 };
    if (a.action === "suppress_budget" && a.queueExhausted) s = { ...s, exhaustedQueuedToday: true };
  }
  return out;
}

describe("decide (security-alerting spec §2.6)", () => {
  it("subject mode: send, then cooldown, then send after the cooldown", () => {
    const first = decide("stuffing", fresh);
    expect(first).toEqual({ action: "send", cooldownUntilMs: NOW + 60 * 60_000 });
    expect(decide("stuffing", { ...fresh, cooldownUntilMs: NOW + 1 }).action).toBe("suppress_cooldown");
    expect(decide("stuffing", { ...fresh, cooldownUntilMs: NOW }).action).toBe("send");
  });

  it("the first budget refusal of a subject class queues budget_exhausted; the second does not", () => {
    const budget = CLASS_POLICY.ip_burst.dailyBudget;
    expect(decide("ip_burst", { ...fresh, classSentToday: budget })).toEqual({ action: "suppress_budget", queueExhausted: true });
    expect(decide("ip_burst", { ...fresh, classSentToday: budget, exhaustedQueuedToday: true })).toEqual({
      action: "suppress_budget",
      queueExhausted: false,
    });
    expect(run("ip_burst", budget + 2).filter((a) => a === "send")).toHaveLength(budget);
  });

  it("a summary class summarises after its onset and is never refused", () => {
    expect(decide("storm", fresh).action).toBe("send");
    expect(decide("storm", { ...fresh, onsetSentToday: true, classSentToday: 99 }).action).toBe("summarise");
  });

  it("THE DECOY TEST: purge, storm and ip_burst exhausted → a targeted_account crossing still sends", () => {
    const spent = (c: SignalClass) => ({ ...fresh, onsetSentToday: true, classSentToday: CLASS_POLICY[c].dailyBudget });
    expect(decide("purge", spent("purge")).action).toBe("summarise");
    expect(decide("storm", spent("storm")).action).toBe("summarise");
    expect(decide("ip_burst", spent("ip_burst")).action).toBe("suppress_budget");
    expect(decide("account", fresh).action).toBe("send");
  });

  it("dailyMessageCeiling() is 96", () => {
    expect(dailyMessageCeiling()).toBe(96);
  });

  it("SUMMARY INVARIANT (m-c): every summary class's budget ≥ its number of signals", () => {
    for (const [c, p] of Object.entries(CLASS_POLICY)) {
      if (p.mode !== "summary") continue;
      const signals = SIGNAL_RULES.filter((r) => r.signalClass === c).length;
      expect(p.dailyBudget, c).toBeGreaterThanOrEqual(signals);
    }
  });
});

describe("HeldReportBuilder", () => {
  it("refuses the entry that would pass the byte cap, and every one after it", () => {
    const entry = { signal: "credential_stuffing" as const, subject: { kind: "ip_prefix" as const, value: "2001:db8::/64" }, events: 12, suppressed: 1 };
    const size = JSON.stringify(entry).length + 1;
    const b = new HeldReportBuilder(size * 2);
    expect(b.tryAdd(entry)).toBe(true);
    expect(b.tryAdd(entry)).toBe(true);
    expect(b.tryAdd(entry)).toBe(false);
    expect(b.entries).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Implement.** `security-ledger-policy.ts` is the spec's §2.6 `ts` block verbatim.

The file is the spec block exactly (checked byte for byte, LF, when this plan was generated).

`security-ledger-types.ts` (P-1):

```ts
import type { SecurityAlertSignal, SignalClass } from "./security-alert";
import type { SubjectKind } from "./security-signals";

/**
 * One threshold crossing, as a counter instance hands it to the ledger
 * (security-alerting spec §2.4 step 4). The subject is RAW here (a /64, a
 * network, a user id, "none" or "site"): only the ledger mints account refs,
 * so no message ever carries a user id (§3.3).
 */
export interface CounterReport {
  readonly signal: SecurityAlertSignal;
  readonly signalClass: SignalClass;
  readonly subjectKind: SubjectKind;
  readonly subject: string;
  /** Epoch ms of the first minute bucket counted. */
  readonly windowStartMs: number;
  /** Epoch ms when the threshold was crossed (widened when reports merge). */
  readonly windowEndMs: number;
  /** Distinct members, or events, in the window (a distinct count is capped at 2 × threshold). */
  readonly observed: number;
  /** Events in the window, never capped; summed when reports merge. */
  readonly events: number;
  readonly threshold: number;
  readonly severity: "warning" | "critical";
  readonly byRoute: Readonly<Record<string, number>>;
}

/** What one `ledger.report()` call carries (§2.4, alarm step 1). */
export interface LedgerReportBatch {
  readonly reports: readonly CounterReport[];
  /**
   * Reports a counter COUNTED instead of storing, because 10,000 were already
   * pending (§2.4 m4), per class. The ledger adds them to `held_overflow`.
   */
  readonly countedOverflow: Readonly<Partial<Record<SignalClass, number>>>;
}

/** The ledger's RPC surface as a counter sees it. */
export interface SecurityLedgerReportRpc {
  report(batch: LedgerReportBatch): Promise<void>;
}

/** Summary-class activity for one signal over a period (§3.2 `DigestClassLine.activity`; I-8). */
export interface SignalActivity {
  readonly events: number;
}

/** `site.summarise(fromMinute, toMinute)`'s answer (§2.6, alarm step 5), over `[fromMinute, toMinute)`. */
export interface SiteSummary {
  readonly activity: Readonly<Record<string, SignalActivity>>;
  /** Increments a Worker folded into `overflowEvents` (§2.5), summed over the period. */
  readonly overflowEvents: number;
}

/** The `site` counter instance's read surface, as the ledger sees it. */
export interface SiteSummaryRpc {
  summarise(fromMinute: number, toMinute: number): Promise<SiteSummary>;
}
```

`index.ts` (PR 3 adds one more line, Task 25):

```diff
--- a/packages/shared/src/index.ts
+++ b/packages/shared/src/index.ts
@@ -16,3 +16,9 @@
 export * from './security-log';
 export * from './social';
 export * from './timing-safe';
+export * from './account-notices';
+export * from './security-alert';
+export * from './security-buffer';
+export * from './security-ledger-policy';
+export * from './security-ledger-types';
+export * from './security-signals';
```

- [ ] **Step 3: GREEN.** `pnpm --filter @thinkersjournal/shared test` and `pnpm --filter @thinkersjournal/shared typecheck`.

### Task 6: The Postmark outcome sibling and `classifyPostmark`

**Files:** create `packages/shared/src/account-notices.ts` (PR 1 subset), `packages/shared/test/account-notices.test.ts`; modify `apps/api/src/auth/postmark.ts`, `apps/api/test/postmark.test.ts`.

**Produces:** `PostmarkOutcome`, `classifyPostmark(o)` (§4.4, verbatim); `postmarkSendOutcome(env: Env, msg: PostmarkMessage): Promise<PostmarkOutcome>`; `postmarkSend` unchanged in signature, now `(await postmarkSendOutcome(env, msg)).ok`.

⚠️ **PM ruling:** the sibling parses the JSON body on a **non-2xx** too. Postmark sends per-recipient refusals as **HTTP 422 with an `ErrorCode` body**; the current code returns at `!res.ok` (`postmark.ts:58-64`) before reading `ErrorCode` (`:66-67`). The 422-with-406 case is pinned below. ⚠️ It never logs `Message` on a non-2xx: Postmark's 406 message names the inactive address.

- [ ] **Step 1: RED.**

```ts
import { describe, expect, it } from "vitest";

import { classifyPostmark } from "../src/account-notices";

describe("classifyPostmark (PR 1; security-alerting spec §4.4)", () => {
  it.each([
    [{ ok: true } as const, "sent"],
    [{ ok: false, status: 422, errorCode: 300 } as const, "permanent"],
    [{ ok: false, status: 422, errorCode: 406 } as const, "permanent"],
    [{ ok: false, status: 422, errorCode: 10 } as const, "transient"],
    [{ ok: false, status: 422, errorCode: 412 } as const, "transient"],
    [{ ok: false, status: 422, errorCode: 1480 } as const, "transient"],
    [{ ok: false, status: 429, errorCode: null } as const, "transient"],
    [{ ok: false, status: 500, errorCode: null } as const, "transient"],
    [{ ok: false, status: null, errorCode: null } as const, "transient"],
  ])("%j → %s", (outcome, want) => expect(classifyPostmark(outcome)).toBe(want));
});
```

and append to `apps/api/test/postmark.test.ts`:

```diff
--- a/apps/api/test/postmark.test.ts
+++ b/apps/api/test/postmark.test.ts
@@ -1,7 +1,9 @@
 import { env } from "cloudflare:test";
 import { afterEach, describe, expect, it, vi } from "vitest";
 
-import { postmarkSend } from "../src/auth/postmark";
+import { classifyPostmark } from "@thinkersjournal/shared";
+
+import { postmarkSend, postmarkSendOutcome } from "../src/auth/postmark";
 
 /**
  * Task 5 (M2.3c) — the generic Postmark transport shared by the verification
@@ -77,3 +79,44 @@
     expect(await postmarkSend(env, msg)).toBe(false);
   });
 });
+
+describe("postmarkSendOutcome (security-alerting spec §4.4; PM ruling: parse the body on a non-2xx)", () => {
+  it("an HTTP 422 whose JSON body carries ErrorCode 406 → errorCode 406 → permanent", async () => {
+    vi.spyOn(console, "error").mockImplementation(() => undefined);
+    stubPostmark({ status: 422, body: { ErrorCode: 406, Message: "inactive: r@e.test" } });
+    const outcome = await postmarkSendOutcome(env, msg);
+    expect(outcome).toEqual({ ok: false, status: 422, errorCode: 406 });
+    expect(classifyPostmark(outcome)).toBe("permanent");
+  });
+
+  it("never logs Message on a non-2xx: Postmark's 406 message names the recipient", async () => {
+    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
+    stubPostmark({ status: 422, body: { ErrorCode: 406, Message: "inactive: r@e.test" } });
+    await postmarkSendOutcome(env, msg);
+    expect(JSON.stringify(err.mock.calls)).not.toContain("r@e.test");
+    expect(err).toHaveBeenCalledWith("postmark send failed", expect.objectContaining({ status: 422, ErrorCode: 406 }));
+  });
+
+  it("a non-JSON non-2xx → errorCode null → transient; a thrown request → status null", async () => {
+    vi.spyOn(console, "error").mockImplementation(() => undefined);
+    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })));
+    expect(await postmarkSendOutcome(env, msg)).toEqual({ ok: false, status: 401, errorCode: null });
+    vi.stubGlobal(
+      "fetch",
+      vi.fn(async () => {
+        throw new Error("boom");
+      }),
+    );
+    const thrown = await postmarkSendOutcome(env, msg);
+    expect(thrown).toEqual({ ok: false, status: null, errorCode: null });
+    expect(classifyPostmark(thrown)).toBe("transient");
+  });
+
+  it("an accept → { ok: true }, and postmarkSend stays its boolean view", async () => {
+    stubPostmark({ body: { ErrorCode: 0 } });
+    expect(await postmarkSendOutcome(env, msg)).toEqual({ ok: true });
+    stubPostmark({ status: 422, body: { ErrorCode: 300 } });
+    vi.spyOn(console, "error").mockImplementation(() => undefined);
+    expect(await postmarkSend(env, msg)).toBe(false);
+  });
+});
```

- [ ] **Step 2: Implement.**

```ts
/**
 * Account-holder notices (security-alerting spec §4). PR 1 ships only the
 * Postmark outcome and its classification; PR 2 adds the rest of §4.1–§4.2.
 */
/** What `postmarkSend` saw, before it collapses to a boolean (§4.4). */
export type PostmarkOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number | null; readonly errorCode: number | null };

/**
 * Postmark's per-recipient refusals that no retry can fix: 300 (send validation,
 * e.g. an invalid address) and 406 (inactive recipient). Everything else (a
 * thrown request, a timeout, HTTP 429 or 5xx, and account-level codes such as
 * 10, 412 or 1480 that an operator must fix) is transient for this notice.
 */
export function classifyPostmark(o: PostmarkOutcome): "sent" | "permanent" | "transient" {
  if (o.ok) return "sent";
  return o.errorCode === 300 || o.errorCode === 406 ? "permanent" : "transient";
}
```

```diff
--- a/apps/api/src/auth/postmark.ts
+++ b/apps/api/src/auth/postmark.ts
@@ -16,6 +16,8 @@
  * recipient address and (for notifications) an unsubscribe token. Logs only
  * status / ErrorCode / Message, exactly as the verification send always has.
  */
+import type { PostmarkOutcome } from "@thinkersjournal/shared";
+
 interface PostmarkResponse {
   ErrorCode?: number;
   Message?: string;
@@ -31,10 +33,37 @@
   headers?: { Name: string; Value: string }[];
 }
 
-export async function postmarkSend(
-  env: Env,
-  msg: PostmarkMessage,
-): Promise<boolean> {
+/**
+ * The body as Postmark's JSON shape, or null. Read on EVERY status: Postmark
+ * reports per-recipient refusals (ErrorCode 300, 406) as HTTP 422 WITH a JSON
+ * body (security-alerting spec §4.4), and a 401 may carry plain text.
+ */
+async function readPostmarkBody(res: Response): Promise<PostmarkResponse | null> {
+  try {
+    const parsed: unknown = JSON.parse(await res.text());
+    return typeof parsed === "object" && parsed !== null ? (parsed as PostmarkResponse) : null;
+  } catch {
+    return null;
+  }
+}
+
+/**
+ * The boolean view, kept for every existing caller: true ONLY on a confirmed
+ * accept. See `postmarkSendOutcome` for what a refusal was.
+ */
+export async function postmarkSend(env: Env, msg: PostmarkMessage): Promise<boolean> {
+  return (await postmarkSendOutcome(env, msg)).ok;
+}
+
+/**
+ * The same send, answering WHAT happened (status and `ErrorCode`), so a deferred
+ * account notice can tell a permanent refusal from a transient one
+ * (`classifyPostmark`, packages/shared). Never throws.
+ *
+ * ⚠️ NEVER LOGS `Message` ON A NON-2xx. Postmark's 406 message names the
+ * inactive recipient's address; this file never logs a recipient (header).
+ */
+export async function postmarkSendOutcome(env: Env, msg: PostmarkMessage): Promise<PostmarkOutcome> {
   try {
     const res = await fetch("https://api.postmarkapp.com/email", {
       method: "POST",
@@ -55,26 +84,27 @@
       }),
     });
 
+    const body = await readPostmarkBody(res);
+    const errorCode = typeof body?.ErrorCode === "number" ? body.ErrorCode : null;
     if (!res.ok) {
       console.error("postmark send failed", {
         status: res.status,
+        ErrorCode: errorCode,
         stream: msg.stream,
       });
-      return false;
+      return { ok: false, status: res.status, errorCode };
     }
-
-    const { ErrorCode, Message } = (await res.json()) as PostmarkResponse;
-    if (ErrorCode !== 0) {
+    if (errorCode !== 0) {
       console.error("postmark rejected send", {
-        ErrorCode,
-        Message,
+        ErrorCode: errorCode,
+        Message: body?.Message,
         stream: msg.stream,
       });
-      return false;
+      return { ok: false, status: res.status, errorCode };
     }
-    return true;
+    return { ok: true };
   } catch (err) {
     console.error("postmark request threw", err);
-    return false;
+    return { ok: false, status: null, errorCode: null };
   }
 }
```

- [ ] **Step 3: GREEN.** `…/api test -- test/postmark.test.ts test/email-verify.test.ts` (the latter pins both existing log lines, `email-verify.test.ts:397-443`). Mutation control: move the body read back below the `!res.ok` return; the 422/406 case goes RED; restore.

### Task 7: Bindings, migration `v4`, flags, test setup, and the flags' runbook entry

**Files:** modify `apps/api/wrangler.jsonc`, `apps/api/src/worker-configuration.d.ts`, `apps/api/vitest.config.ts`, `apps/web/wrangler.jsonc`, `apps/web/worker-configuration.d.ts`, `docs/runbooks/deploy.md`; create `apps/api/test/setup/security-counting.ts`, `apps/api/test/security-bindings.node.test.ts`.

- [ ] **Step 0: Implementer confirmation 1 (before any web code).** Verify `script_name` against the installed wrangler's config schema (as `ratelimits` was, `apps/api/wrangler.jsonc:118-125`), and that an RPC to the api's class works from the Astro Worker under `wrangler dev` with both Workers running. If either fails, stop and return the work to the PM.
- [ ] **Step 1: RED.** The Node test reads the real files (workerd's filesystem is virtual, `vitest.config.ts:209-215`):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

/**
 * The security-alerting bindings, read from the REAL config files (plan Task 7).
 * A Node test because workerd's filesystem is virtual (vitest.config.ts); the
 * pool would create whatever it is told, so only the source can be pinned.
 */
const API_DIR = join(import.meta.dirname, "..");
const WEB_DIR = join(API_DIR, "../web");

interface DoBinding {
  name: string;
  class_name: string;
  script_name?: string;
}
interface WranglerConfig {
  durable_objects?: { bindings?: DoBinding[] };
  migrations?: { tag: string; new_sqlite_classes?: string[] }[];
  vars?: Record<string, string>;
}

const read = (dir: string): WranglerConfig => parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as WranglerConfig;

describe("api wrangler.jsonc", () => {
  const api = read(API_DIR);

  it("binds both classes", () => {
    expect(api.durable_objects?.bindings).toEqual(
      expect.arrayContaining([
        { name: "SECURITY_COUNTER", class_name: "SecurityCounterDO" },
        { name: "SECURITY_LEDGER", class_name: "SecurityLedgerDO" },
      ]),
    );
  });

  it("adds migration v4 AFTER v3, creating exactly the two classes", () => {
    const tags = api.migrations?.map((m) => m.tag);
    expect(tags?.slice(-2)).toEqual(["v3", "v4"]);
    expect(api.migrations?.at(-1)?.new_sqlite_classes).toEqual(["SecurityCounterDO", "SecurityLedgerDO"]);
  });

  it("ships every flag off but counting (spec §6 phase 1), and never TEST_ROUTES", () => {
    expect(api.vars).toEqual({ SECURITY_COUNTING: "on", SECURITY_ALERTS_ENABLED: "0", ACCOUNT_NOTICES_ENABLED: "0" });
  });
});

describe("web wrangler.jsonc", () => {
  const web = read(WEB_DIR);

  it("binds SECURITY_COUNTER cross-script to the api's class", () => {
    expect(web.durable_objects?.bindings).toEqual([
      { name: "SECURITY_COUNTER", class_name: "SecurityCounterDO", script_name: "thinkersjournal-api" },
    ]);
  });

  it("declares no migrations of its own (the class lives in the api)", () => {
    expect(web.migrations).toBeUndefined();
  });

  it("has the web half of the kill switch", () => {
    expect(web.vars).toEqual({ SECURITY_COUNTING: "on" });
  });
});
```

- [ ] **Step 2: Implement.**

```diff
--- a/apps/api/wrangler.jsonc
+++ b/apps/api/wrangler.jsonc
@@ -94,13 +94,22 @@
     "bindings": [
       { "name": "USER_SECURITY", "class_name": "UserSecurityDO" },
       { "name": "NOTIFY", "class_name": "NotifyDO" },
-      { "name": "POST_LIVE", "class_name": "PostLiveDO" }
+      { "name": "POST_LIVE", "class_name": "PostLiveDO" },
+      // SECURITY_COUNTER / SECURITY_LEDGER — security alerting
+      // (docs/superpowers/specs/2026-10-07-security-alerting-design.md §2.1).
+      // The counter has a FIXED set of 33 instances (`ip:0`…`ip:15`,
+      // `acct:0`…`acct:15`, `site`); the ledger has one, `ledger`. Neither is
+      // reachable from a route. apps/web binds SECURITY_COUNTER cross-script, so
+      // this Worker must deploy the classes BEFORE web deploys the binding.
+      { "name": "SECURITY_COUNTER", "class_name": "SecurityCounterDO" },
+      { "name": "SECURITY_LEDGER", "class_name": "SecurityLedgerDO" }
     ]
   },
   "migrations": [
     { "tag": "v1", "new_sqlite_classes": ["UserSecurityDO"] },
     { "tag": "v2", "new_sqlite_classes": ["NotifyDO"] },
-    { "tag": "v3", "new_sqlite_classes": ["PostLiveDO"] }
+    { "tag": "v3", "new_sqlite_classes": ["PostLiveDO"] },
+    { "tag": "v4", "new_sqlite_classes": ["SecurityCounterDO", "SecurityLedgerDO"] }
   ],
   // ⚠️ THE PURGE HOP — api CANNOT purge web's cache.
   // Workers Cache purge is scoped to the Worker+entrypoint that OWNS the cache:
@@ -294,6 +303,17 @@
   "observability": {
     "enabled": true
   },
+  // Security alerting flags (spec §3.1, §6). Reviewed like any config: flipping
+  // one is a one-line PR plus a deploy. ⚠️ A dashboard edit works as an
+  // emergency stop, but the NEXT `wrangler deploy` resets it to this file's
+  // value. SECURITY_COUNTING "off" is the counting kill switch; the other two
+  // stay "0" until phase 1b (notices) and board 131 (a transport). TEST_ROUTES
+  // is deliberately NOT here (see vitest.config.ts).
+  "vars": {
+    "SECURITY_COUNTING": "on",
+    "SECURITY_ALERTS_ENABLED": "0",
+    "ACCOUNT_NOTICES_ENABLED": "0"
+  },
   // Build-identity (2026-09-24) — GET /health/build reads this. Cloudflare's
   // OWN version registry populates `id`/`tag`/`timestamp` on every deploy
   // regardless of build command, unlike a git SHA baked in by a build script
```

```diff
--- a/apps/web/wrangler.jsonc
+++ b/apps/web/wrangler.jsonc
@@ -220,6 +220,23 @@
       "simple": { "limit": 5, "period": 60 }
     }
   ],
+  // Security alerting (docs/superpowers/specs/2026-10-07-security-alerting-design.md
+  // §2.2 item 4): a CROSS-SCRIPT binding to the api's counter class, used only
+  // by POST /internal/purge (src/lib/security-counting.ts). No `migrations`
+  // here: the class lives in, and is migrated by, thinkersjournal-api.
+  // ⚠️ DEPLOY ORDER: the api must deploy the class (its migration v4) BEFORE
+  // this binding deploys, the same kind of first-deploy ordering as the purge
+  // hop (apps/api/wrangler.jsonc's `services` comment).
+  "durable_objects": {
+    "bindings": [
+      { "name": "SECURITY_COUNTER", "class_name": "SecurityCounterDO", "script_name": "thinkersjournal-api" }
+    ]
+  },
+  // The web half of the counting kill switch (spec §3.1): "off" makes the purge
+  // page pass a no-op. A dashboard edit is reset by the next `wrangler deploy`.
+  "vars": {
+    "SECURITY_COUNTING": "on"
+  },
   "observability": {
     "enabled": true
   },
```

`apps/api/src/worker-configuration.d.ts` (hand-added, the file's pattern, `:20-25`, `:49-53`; PR 1's lines):

```diff
--- a/apps/api/src/worker-configuration.d.ts
+++ b/apps/api/src/worker-configuration.d.ts
@@ -67,6 +67,18 @@
 	NOTIFY: DurableObjectNamespace<import("./index").NotifyDO>;
 	POST_LIVE: DurableObjectNamespace<import("./index").PostLiveDO>;
 	WEB: Fetcher /* thinkersjournal-web */;
+	// Security alerting, phase 1 (docs/superpowers/specs/2026-10-07-security-alerting-design.md)
+	// — added by hand, same established pattern and reason as the brute-force
+	// limiters above. Both classes are exported from ./index; the three flags
+	// come from wrangler.jsonc's `vars`; the two secrets stay unset until board
+	// 131 picks a transport, so they are optional.
+	SECURITY_COUNTER: DurableObjectNamespace<import("./index").SecurityCounterDO>;
+	SECURITY_LEDGER: DurableObjectNamespace<import("./index").SecurityLedgerDO>;
+	SECURITY_COUNTING: string;
+	SECURITY_ALERTS_ENABLED: string;
+	ACCOUNT_NOTICES_ENABLED: string;
+	SECURITY_ALERT_EMAIL?: string;
+	SECURITY_ALERT_RELAY_TOKEN?: string;
 	// Build-identity (2026-09-24) — added by hand, same reason as CF_ACCESS_*
 	// above: a full `wrangler types` regeneration in this checkout drops
 	// several hand-added bindings and pulls in an unrelated diff. See
@@ -83,7 +95,7 @@
 declare namespace Cloudflare {
 	interface GlobalProps {
 		mainModule: typeof import("./index");
-		durableNamespaces: "UserSecurityDO" | "NotifyDO" | "PostLiveDO";
+		durableNamespaces: "UserSecurityDO" | "NotifyDO" | "PostLiveDO" | "SecurityCounterDO" | "SecurityLedgerDO";
 	}
 	interface Env extends __BaseEnv_Env {}
 }
```

`apps/web/worker-configuration.d.ts` (P-11):

```diff
--- a/apps/web/worker-configuration.d.ts
+++ b/apps/web/worker-configuration.d.ts
@@ -8,6 +8,14 @@
 	// Brute-force countermeasure (2026-10-06 audit, src/lib/purge.ts) — added by
 	// hand, same reason as CF_VERSION_METADATA below.
 	PURGE_LIMITER: RateLimit;
+	// Security alerting (docs/superpowers/specs/2026-10-07-security-alerting-design.md
+	// §2.2 item 4) — added by hand, same reason as PURGE_LIMITER. A CROSS-SCRIPT
+	// binding to the api's SecurityCounterDO: `wrangler types` would emit an
+	// untyped DurableObjectNamespace with no RPC methods, so this states the one
+	// method the purge page calls. SECURITY_COUNTING is the web half of the kill
+	// switch (wrangler.jsonc `vars`).
+	SECURITY_COUNTER: { getByName(name: string): import("@thinkersjournal/shared").SecurityCounterRpc };
+	SECURITY_COUNTING: string;
 	// Build-identity (2026-09-24) — added by hand rather than a full
 	// regeneration, matching apps/api/src/worker-configuration.d.ts's
 	// established CF_ACCESS_* precedent: a full `wrangler types` run here
```

The pool setup file (P-8) and its registration:

```ts
import { beforeEach } from "vitest";

import { SecurityEventBuffer } from "@thinkersjournal/shared";

import { setSecurityScopeOverridesForTests } from "../../src/security/scope";

/**
 * Pool-project setup (vitest.config.ts `setupFiles`; security-alerting plan).
 * Before EVERY test, counting gets a buffer that flushes at once into
 * counter stubs that drop the batch.
 *
 * ⚠️ WHY THIS IS NOT OPTIONAL. In production the buffer flushes inside the
 * request's `waitUntil` after FLUSH_DELAY_MS (5 s). A test that awaits
 * `waitOnExecutionContext` after any `security:` event would therefore wait
 * 5 s per request, and a rate-limit burst (test/login.test.ts,
 * test/reset-password.test.ts) would straddle the emulator's wall-clock limiter
 * window and lose its count (test/helpers/limiter-window.ts). Observed in the
 * plan's full-suite run: five rate-limit burst tests failed until this existed.
 *
 * It also keeps unrelated tests from writing into the REAL counter instances.
 * A test that asserts on counting installs its own overrides; its afterEach may
 * reset them with `null`, and this hook restores the default before the next.
 */
beforeEach(() => {
  setSecurityScopeOverridesForTests({
    buffer: new SecurityEventBuffer(() => Promise.resolve()),
    stubFor: () => ({ record: async () => undefined }),
  });
});
```

```diff
--- a/apps/api/vitest.config.ts
+++ b/apps/api/vitest.config.ts
@@ -195,6 +195,9 @@
         test: {
           name: "pool",
           include: ["test/**/*.test.ts"],
+          // Security alerting: counting flushes at once into no-op stubs unless a
+          // test installs its own (see the file for why bursts need this).
+          setupFiles: ["./test/setup/security-counting.ts"],
           // ⚠️ NOT A LATENCY ASSERTION — a headroom for REAL I/O. Every test in
           // this project drives the handlers through workerd against the live
           // Docker Postgres, and the seed-heavy ones do many SEQUENTIAL DB
```

Runbook (§3.1: "the runbook must say so"): insert after the `RESERVED_EMAIL_KEY` section (`docs/runbooks/deploy.md:143-168`):

````md
## Security alerting: the flags

`SECURITY_COUNTING` (api and web; "off" is the counting kill switch),
`SECURITY_ALERTS_ENABLED` and `ACCOUNT_NOTICES_ENABLED` (api) live in each
Worker's `wrangler.jsonc` `vars`. Flipping one is a one-line PR plus a deploy.
A dashboard edit works as an emergency stop, but **the next `wrangler deploy`
resets it to the file's value.**

Deploy order for the first deploy: the api (which creates the two Durable
Object classes, migration `v4`) before the web Worker (which binds the api's
counter class cross-script).
````

- [ ] **Step 3: GREEN.** `…/api test -- test/security-bindings.node.test.ts test/purge-binding.node.test.ts`. ⚠️ `Env`'s two new bindings point at `import("./index").SecurityCounterDO`/`SecurityLedgerDO`, which exist only once Task 11 exports them; `skipLibCheck` hides that gap in the `.d.ts`, so the api typecheck that counts is Task 11's.

### Task 8: `SecurityCounterDO`

**Files:** create `apps/api/src/durable-objects/SecurityCounterDO.ts`, `apps/api/src/security/counter-schema.ts`, `apps/api/test/helpers/security-do.ts`, `apps/api/test/security-counter-do.test.ts`.

**Consumes:** `CounterBatch`, `SIGNAL_RULES`, `CLASS_POLICY`, `CounterReport`, `SecurityLedgerReportRpc`, `logSecurityEvent`. **Produces:** RPC `record(batch: CounterBatch): Promise<void>`, RPC `summarise(fromMinute: number, toMinute: number): Promise<SiteSummary>` (site only; half-open), `alarm()`; test entry points `recordAt(batch, nowMs)`, `alarmAt(nowMs)`; seams `ledgerFor`, `armAt`; `reportRetryDelayMs(attempts)`, `mergeReports(a, b)`, `COUNTER_RETENTION_MINUTES`.

Behaviour (§2.4): members are salted SHA-256 truncated to 32 hex, hashed **before** the synchronous transaction; `credential_stuffing` stores members only from its subject's 3rd event; no rule stores more than 2 × threshold members per window; a crossing reports once per window; a pending report for the same (signal, subject) is merged (m4); past 10,000 pending reports a new one is counted per class; failed reports back off 1, 5, then every 15 minutes, forever, logging `security: alerting_fault security-ledger ledger_unreachable` each time; retention 60 min (overflow 2 h); `deleteAll()` when everything but `meta` is empty, then the tables are recreated. ⚠️ **No delete-after-await (I-2):** the reports being sent are detached (merge key `inflight:<id>`) before the RPC, so a crossing arriving during it lands in a new row; the overflow counts sent are subtracted, not deleted; a failed send re-attaches each report, merged into anything that arrived meanwhile.

- [ ] **Step 1: RED.** The helper (Tasks 8–9 share it), then the test:

```ts
import { env } from "cloudflare:test";

import type {
  CounterReport,
  CounterRow,
  SecurityAlertMessage,
  SecurityAlertSignal,
  SecurityAlertSink,
} from "@thinkersjournal/shared";

/**
 * Security-alerting test helpers (plan Tasks 8–9). Every stub is a FRESH
 * instance (a unique name), so tests never share storage. Production uses the
 * names `ip:0`…`site` and `ledger`; nothing in either class depends on its name.
 *
 * ⚠️ NO TEST SLEEPS. Both classes expose `recordAt`/`reportAt`/`alarmAt` with an
 * explicit clock (spec §2.4 "Clock"); tests call them through
 * `runInDurableObject`. This repo had no Durable Object alarm test before this
 * plan (0 hits for `alarm` in apps/api/test at f3da62d; the same grep finds
 * `evictAllDurableObjects` in test/user-security-do.test.ts).
 */
export const T0 = Date.parse("2026-10-07T12:00:00.000Z");
export const MINUTE = 60_000;
export const HOUR = 3_600_000;

export function freshCounter() {
  return env.SECURITY_COUNTER.getByName(`test-counter-${crypto.randomUUID()}`);
}

export function freshLedger() {
  return env.SECURITY_LEDGER.getByName(`test-ledger-${crypto.randomUUID()}`);
}

/** One aggregated buffer row, as `SecurityEventBuffer.flush` would send it. */
export function counterRow(
  signal: SecurityAlertSignal,
  subject: string,
  n: number,
  nowMs: number,
  members: readonly string[] = [],
  route = "/auth/login",
): CounterRow {
  return { signal, subject, route, minute: Math.floor(nowMs / MINUTE), n, members };
}

/** A crossing as a counter would report it. */
export function crossing(over: Partial<CounterReport> = {}): CounterReport {
  return {
    signal: "credential_stuffing",
    signalClass: "stuffing",
    subjectKind: "ip",
    subject: "2001:db8:1:2::/64",
    windowStartMs: T0 - 10 * MINUTE,
    windowEndMs: T0,
    observed: 10,
    events: 12,
    threshold: 10,
    severity: "critical",
    byRoute: { "/auth/login": 12 },
    ...over,
  };
}

/** A sink that records what it was sent; `fail` decides per call whether to refuse. */
export function capturingSink(fail: (m: SecurityAlertMessage) => boolean = () => false) {
  const sent: SecurityAlertMessage[] = [];
  const sink: SecurityAlertSink = {
    name: "capture",
    send: async (m) => {
      if (fail(m)) return { delivered: false, reason: "test" };
      sent.push(m);
      return { delivered: true };
    },
  };
  return { sink, sent };
}

/** Only the messages of one type, narrowed. */
export function ofType<T extends SecurityAlertMessage["type"]>(
  sent: readonly SecurityAlertMessage[],
  type: T,
): Extract<SecurityAlertMessage, { type: T }>[] {
  return sent.filter((m): m is Extract<SecurityAlertMessage, { type: T }> => m.type === type);
}

/**
 * Replace a Durable Object's `armAt` seam with a recorder. ⚠️ Without this a
 * REAL alarm, set for an instant in the past of the wall clock, fires during the
 * test and runs `alarm()` at the real time, racing the test's explicit clock.
 */
export function quiet(instance: { armAt: (ms: number) => Promise<void> }): number[] {
  const armed: number[] = [];
  instance.armAt = async (ms) => {
    armed.push(ms);
  };
  return armed;
}
```

```ts
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SIGNAL_RULES, type CounterReport, type LedgerReportBatch } from "@thinkersjournal/shared";

import { reportRetryDelayMs } from "../src/durable-objects/SecurityCounterDO";

import { counterRow, freshCounter, HOUR, MINUTE, quiet, T0 } from "./helpers/security-do";

/**
 * `SecurityCounterDO` (security-alerting spec §2.4). Pool project,
 * real Durable Object storage, explicit clock through `runInDurableObject`.
 */
afterEach(() => vi.restoreAllMocks());

type Count = { n: number };

/** A ledger fake: records each batch; `fail` makes `report` reject. */
function fakeLedger(fail = false) {
  const batches: LedgerReportBatch[] = [];
  return {
    batches,
    rpc: {
      report: async (b: LedgerReportBatch) => {
        if (fail) throw new Error("ledger down");
        batches.push(b);
      },
    },
  };
}

function pendingReports(sql: SqlStorage): CounterReport[] {
  return sql
    .exec<{ report: string }>("SELECT report FROM reports ORDER BY id")
    .toArray()
    .map((r) => JSON.parse(r.report) as CounterReport);
}

const EVENTS_RULES = SIGNAL_RULES.filter((r) => r.measure === "events");

describe("threshold boundary, every events rule", () => {
  it.each(EVENTS_RULES.map((r) => [r.signal, r] as const))("%s: threshold − 1 → none; threshold → one; more → still one", async (_s, rule) => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      const subject = rule.subject === "site" ? "site" : rule.subject === "account" ? "user-1" : "203.0.113.0/24";
      const route = rule.signal.startsWith("reset") ? "/auth/reset-password" : "/auth/login";
      await c.recordAt({ rows: [counterRow(rule.signal, subject, rule.threshold - 1, T0, [], route)], overflowEvents: 0 }, T0);
      expect(pendingReports(state.storage.sql)).toHaveLength(0);
      await c.recordAt({ rows: [counterRow(rule.signal, subject, 1, T0, [], route)], overflowEvents: 0 }, T0);
      expect(pendingReports(state.storage.sql)).toHaveLength(1);
      await c.recordAt({ rows: [counterRow(rule.signal, subject, 5, T0, [], route)], overflowEvents: 0 }, T0);
      expect(pendingReports(state.storage.sql)).toHaveLength(1);
    });
  });

  it("the next window still over threshold → a second crossing (merged while the first is pending)", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 50, T0)], overflowEvents: 0 }, T0);
      const later = T0 + 11 * MINUTE;
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 50, later)], overflowEvents: 0 }, later);
      const reports = pendingReports(state.storage.sql);
      expect(reports).toHaveLength(1); // m4: merged, not duplicated
      expect(reports[0]?.events).toBe(100);
    });
  });

  it("events older than the window do not count; a burst straddling a minute boundary does", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      const old = T0 - 11 * MINUTE;
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 49, old)], overflowEvents: 0 }, old);
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 1, T0)], overflowEvents: 0 }, T0);
      expect(pendingReports(state.storage.sql)).toHaveLength(0);
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 48, T0 + MINUTE)], overflowEvents: 0 }, T0 + MINUTE);
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 1, T0 + MINUTE)], overflowEvents: 0 }, T0 + MINUTE);
      expect(pendingReports(state.storage.sql)).toHaveLength(1);
    });
  });
});

describe("distinct measures (m2) and member privacy", () => {
  const addresses = (n: number) => Array.from({ length: n }, (_, i) => `person${i}@example.invalid`);

  it("12 failures for 12 addresses from one /64 → 10 counted → one report; 11 → none", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      await c.recordAt({ rows: [counterRow("credential_stuffing", "2001:db8:1:2::/64", 12, T0, addresses(12))], overflowEvents: 0 }, T0);
      const r = pendingReports(state.storage.sql);
      expect(r).toHaveLength(1);
      expect(r[0]?.observed).toBe(10);
    });
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      await c.recordAt({ rows: [counterRow("credential_stuffing", "2001:db8:1:2::/64", 11, T0, addresses(11))], overflowEvents: 0 }, T0);
      expect(pendingReports(state.storage.sql)).toHaveLength(0);
    });
  });

  it("no `members` row equals or contains an address (control: 10 rows exist)", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      const list = addresses(12);
      await c.recordAt({ rows: [counterRow("credential_stuffing", "2001:db8:1:2::/64", 12, T0, list)], overflowEvents: 0 }, T0);
      const stored = state.storage.sql.exec<{ member: string }>("SELECT member FROM members").toArray().map((m) => m.member);
      expect(stored).toHaveLength(10);
      for (const m of stored) for (const a of list) expect(m.includes(a) || a.includes(m)).toBe(false);
    });
  });

  it("500 failures against one account: events 500, a distinct count capped at 2 × threshold", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      const prefixes = Array.from({ length: 500 }, (_, i) => `2001:db8:${i.toString(16)}::/64`);
      await c.recordAt(
        {
          rows: [
            counterRow("targeted_account", "user-1", 500, T0),
            counterRow("distributed_account_guess", "user-1", 500, T0, prefixes),
          ],
          overflowEvents: 0,
        },
        T0,
      );
      const bySignal = new Map(pendingReports(state.storage.sql).map((r) => [r.signal, r]));
      expect(bySignal.get("targeted_account")?.events).toBe(500);
      expect(bySignal.get("distributed_account_guess")?.observed).toBe(10);
      expect(bySignal.get("distributed_account_guess")?.events).toBe(500);
    });
  });
});

describe("an unreachable ledger (N3)", () => {
  it("keeps the report through every alarm, backs off 1, 5, 15, 15 min, logs one fault each, never deletes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      const down = fakeLedger(true);
      c.ledgerFor = () => down.rpc;
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 50, T0)], overflowEvents: 0 }, T0);
      let now = T0;
      const delays: number[] = [];
      for (let i = 1; i <= 4; i++) {
        await c.alarmAt(now);
        const next = state.storage.sql.exec<{ next_ms: number }>("SELECT next_ms FROM reports").one().next_ms;
        delays.push((next - now) / MINUTE);
        now = next;
      }
      expect(delays).toEqual([1, 5, 15, 15]);
      expect(warn.mock.calls.filter((a) => String(a[0]).startsWith("security: alerting_fault security-ledger ledger_unreachable"))).toHaveLength(4);
      const up = fakeLedger(false);
      c.ledgerFor = () => up.rpc;
      await c.alarmAt(now);
      expect(up.batches[0]?.reports).toHaveLength(1);
      expect(state.storage.sql.exec<Count>("SELECT COUNT(*) AS n FROM reports").one().n).toBe(0);
    });
    expect(reportRetryDelayMs(9)).toBe(15 * MINUTE);
  });
});

describe("a crossing that arrives during the ledger call (audit I-2)", () => {
  it("is kept, not deleted with the reports that call delivered", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 50, T0)], overflowEvents: 0 }, T0);
      const later = T0 + 11 * MINUTE;
      const received: LedgerReportBatch[] = [];
      c.ledgerFor = () => ({
        report: async (b: LedgerReportBatch) => {
          received.push(b);
          // The input gate is open while this RPC is awaited: a record lands now.
          await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 60, later)], overflowEvents: 0 }, later);
        },
      });
      await c.alarmAt(T0);
      expect(received[0]?.reports.map((r) => r.events)).toEqual([50]);
      const left = pendingReports(state.storage.sql);
      expect(left.map((r) => r.events)).toEqual([60]);
    });
  });
});

describe("retention", () => {
  it("after alarm(now + 61 min) with nothing pending, storage is empty; a later record makes a new salt", async () => {
    await runInDurableObject(freshCounter(), async (c, state) => {
      quiet(c);
      await c.recordAt({ rows: [counterRow("credential_stuffing", "2001:db8::/64", 3, T0, ["a@example.invalid", "b@example.invalid", "c@example.invalid"])], overflowEvents: 0 }, T0);
      const salt1 = state.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'salt'").one().v;
      expect(state.storage.sql.exec<Count>("SELECT COUNT(*) AS n FROM buckets").one().n).toBeGreaterThan(0); // positive control
      await c.alarmAt(T0 + 61 * MINUTE);
      for (const t of ["buckets", "members", "reports", "last_report", "overflow", "meta"]) {
        expect(state.storage.sql.exec<Count>(`SELECT COUNT(*) AS n FROM ${t}`).one().n, t).toBe(0);
      }
      await c.recordAt({ rows: [counterRow("login_ip_burst", "203.0.113.9", 1, T0 + 2 * HOUR)], overflowEvents: 0 }, T0 + 2 * HOUR);
      const salt2 = state.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'salt'").one().v;
      expect(salt2).not.toBe(salt1);
    });
  });
});

describe("summarise (site)", () => {
  it("returns summary-class events and overflow over the half-open period [from, to) (M-5)", async () => {
    await runInDurableObject(freshCounter(), async (c) => {
      quiet(c);
      const m = Math.floor(T0 / MINUTE);
      await c.recordAt({ rows: [counterRow("rate_limit_storm", "site", 7, T0, [], "/comments")], overflowEvents: 4 }, T0);
      const s = await c.summarise(m - 5, m + 1);
      expect(s.activity.rate_limit_storm).toEqual({ events: 7 });
      expect(s.overflowEvents).toBe(4);
      // The boundary minute belongs to the period that STARTS there, never to both.
      expect((await c.summarise(m - 5, m)).activity.rate_limit_storm).toEqual({ events: 0 });
      expect((await c.summarise(m, m + 1)).activity.rate_limit_storm).toEqual({ events: 7 });
    });
  });
});
```

- [ ] **Step 2: Implement.**

```ts
/**
 * `SecurityCounterDO`'s tables (security-alerting spec §2.4). Every table with a
 * composite key is `WITHOUT ROWID` (R6). One addition to the spec's illustrative
 * DDL (§8 says it was not executed): `reports.rkey`, the (signal, subject) key
 * a pending report is merged on (§2.4 m4), with its index.
 */
export const COUNTER_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS buckets (subject TEXT NOT NULL, minute INTEGER NOT NULL, route TEXT NOT NULL,
     counts TEXT NOT NULL, PRIMARY KEY (subject, minute, route)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS members (signal TEXT NOT NULL, subject TEXT NOT NULL, minute INTEGER NOT NULL,
     member TEXT NOT NULL, PRIMARY KEY (signal, subject, minute, member)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, rkey TEXT NOT NULL, report TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS reports_rkey ON reports (rkey)",
  `CREATE TABLE IF NOT EXISTS last_report (signal TEXT NOT NULL, subject TEXT NOT NULL, at_ms INTEGER NOT NULL,
     PRIMARY KEY (signal, subject)) WITHOUT ROWID`,
  "CREATE TABLE IF NOT EXISTS overflow (minute INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
];
```

```ts
/**
 * `SecurityCounterDO` — counts security events (security-alerting spec §2.4).
 *
 * A FIXED set of 33 instances (`ip:0`…`ip:15`, `acct:0`…`acct:15`, `site`;
 * `shardFor` in packages/shared), so rotating /64s adds rows, never instances.
 * It receives batches from the per-isolate `SecurityEventBuffer`, evaluates the
 * rules in `SIGNAL_RULES`, and reports crossings to the one `SecurityLedgerDO`.
 *
 * ⚠️ NEVER CALLS A SINK. A counter's only outlet is `ledger.report()`; if the
 * ledger is unreachable it keeps the report, backs off, and logs
 * `security: alerting_fault` (§2.4, N3). The raw address of a distinct member
 * never reaches storage: members are salted SHA-256, truncated (§2.4 step 2).
 */
import { DurableObject } from "cloudflare:workers";

import {
  CLASS_POLICY,
  logSecurityEvent,
  SIGNAL_RULES,
  type CounterBatch,
  type CounterReport,
  type CounterRow,
  type SecurityAlertSignal,
  type SecurityLedgerReportRpc,
  type SignalActivity,
  type SignalClass,
  type SignalRule,
  type SiteSummary,
} from "@thinkersjournal/shared";

import { COUNTER_SCHEMA } from "../security/counter-schema";

const MINUTE_MS = 60_000;
/** `buckets`, `members` and `last_report` live at most this long (§2.4 Retention). */
export const COUNTER_RETENTION_MINUTES = 60;
/** `overflow` (site only) lives at most this long. */
export const OVERFLOW_RETENTION_MINUTES = 120;
/** Past this many pending reports, a new subject's report is only counted (§2.4 m4). */
export const MAX_PENDING_REPORTS = 10_000;
/** Reports per `ledger.report()` call (§2.4 alarm step 1). */
export const REPORTS_PER_CALL = 500;
/** With nothing to report, the alarm still runs this often, to prune. */
export const IDLE_ALARM_MS = 10 * MINUTE_MS;
/** `credential_stuffing` stores members only from its subject's 3rd event in the window (§2.4 step 2). */
const STUFFING_MEMBER_SKIP = 2;

const RULES: ReadonlyMap<SecurityAlertSignal, SignalRule> = new Map(SIGNAL_RULES.map((r) => [r.signal, r]));

/** Backoff after the n-th failed report (§2.4 alarm step 2): 1, 5, then every 15 minutes, forever. */
export function reportRetryDelayMs(attempts: number): number {
  if (attempts <= 1) return MINUTE_MS;
  if (attempts === 2) return 5 * MINUTE_MS;
  return 15 * MINUTE_MS;
}

/** A batch row whose members are already salted and hashed. */
interface HashedRow extends Omit<CounterRow, "members"> {
  readonly memberHashes: readonly string[];
}

type CountsRow = { counts: string };
type MinuteCountsRow = { minute: number; route: string; counts: string };
type CountRow = { n: number };
type ReportRow = { id: number; report: string; attempts: number };
type MetaRow = { v: string };

async function memberHash(salt: string, member: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}${member}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function hashRows(rows: readonly CounterRow[], salt: string): Promise<HashedRow[]> {
  return Promise.all(
    rows.map(async ({ members, ...rest }) => ({
      ...rest,
      memberHashes: await Promise.all(members.map((m) => memberHash(salt, m))),
    })),
  );
}

function parseCounts(text: string): Record<string, number> {
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, number>) : {};
}

export class SecurityCounterDO extends DurableObject<Env> {
  /** TEST SEAM (§3.3): tests replace this on the instance via `runInDurableObject`. */
  ledgerFor: () => SecurityLedgerReportRpc = () => this.env.SECURITY_LEDGER.getByName("ledger");
  /** TEST SEAM: where the next alarm goes, so a real alarm never races a test's explicit clock. */
  armAt: (ms: number) => Promise<void> = (ms) => this.ctx.storage.setAlarm(ms);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private ensureSchema(): void {
    for (const ddl of COUNTER_SCHEMA) this.sql.exec(ddl);
  }

  /** RPC (§2.4): one batch from one isolate's flush. */
  async record(batch: CounterBatch): Promise<void> {
    await this.recordAt(batch, Date.now());
  }

  /** `record` with an explicit clock, so tests never sleep (§2.4 Clock). */
  async recordAt(batch: CounterBatch, nowMs: number): Promise<void> {
    // Hashing is async, so it runs BEFORE the transaction, which must stay synchronous.
    const hashed = await hashRows(batch.rows, this.salt());
    const gained = this.ctx.storage.transactionSync(() => this.apply(hashed, batch.overflowEvents, nowMs));
    if (gained) {
      await this.armAt(nowMs);
    } else if ((await this.ctx.storage.getAlarm()) === null) {
      await this.armAt(nowMs + IDLE_ALARM_MS);
    }
  }

  /** The per-instance member salt: 32 random bytes, created on first use, gone with `deleteAll`. */
  private salt(): string {
    const existing = this.sql.exec<MetaRow>("SELECT v FROM meta WHERE k = 'salt'").toArray()[0];
    if (existing !== undefined) return existing.v;
    const fresh = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('salt', ?) ON CONFLICT(k) DO NOTHING", fresh);
    return this.sql.exec<MetaRow>("SELECT v FROM meta WHERE k = 'salt'").one().v;
  }

  /** Steps 1–4 of `record`, inside `transactionSync`. True when `reports` gained a row. */
  private apply(rows: readonly HashedRow[], overflowEvents: number, nowMs: number): boolean {
    const nowMinute = Math.floor(nowMs / MINUTE_MS);
    const touched = new Map<string, HashedRow>();
    for (const row of rows) {
      const rule = RULES.get(row.signal);
      if (rule === undefined) continue;
      const before = this.eventsInWindow(row.signal, row.subject, nowMinute - rule.windowMinutes).events;
      this.addBucket(row);
      this.addMembers(row, rule, before, nowMinute);
      touched.set(`${row.signal}|${row.subject}`, row);
    }
    if (overflowEvents > 0) {
      this.sql.exec(
        "INSERT INTO overflow (minute, n) VALUES (?, ?) ON CONFLICT(minute) DO UPDATE SET n = n + excluded.n",
        nowMinute,
        overflowEvents,
      );
    }
    let gained = false;
    for (const row of touched.values()) {
      if (this.evaluate(row.signal, row.subject, nowMs)) gained = true;
    }
    return gained;
  }

  /** Step 1: one `buckets` row per (subject, minute, route), its JSON counts summed. */
  private addBucket(row: HashedRow): void {
    const found = this.sql
      .exec<CountsRow>("SELECT counts FROM buckets WHERE subject = ? AND minute = ? AND route = ?", row.subject, row.minute, row.route)
      .toArray()[0];
    const counts = found === undefined ? {} : parseCounts(found.counts);
    counts[row.signal] = (counts[row.signal] ?? 0) + row.n;
    this.sql.exec(
      `INSERT INTO buckets (subject, minute, route, counts) VALUES (?, ?, ?, ?)
       ON CONFLICT(subject, minute, route) DO UPDATE SET counts = excluded.counts`,
      row.subject,
      row.minute,
      row.route,
      JSON.stringify(counts),
    );
  }

  /** Step 2: distinct members, with both cost guards (3rd-event start; 2 × threshold per window). */
  private addMembers(row: HashedRow, rule: SignalRule, eventsBefore: number, nowMinute: number): void {
    if (row.memberHashes.length === 0) return;
    const skip = row.signal === "credential_stuffing" ? Math.max(0, STUFFING_MEMBER_SKIP - eventsBefore) : 0;
    const room = 2 * rule.threshold - this.distinctMembers(row.signal, row.subject, nowMinute - rule.windowMinutes, nowMinute);
    for (const member of row.memberHashes.slice(skip, skip + Math.max(0, room))) {
      this.sql.exec(
        "INSERT INTO members (signal, subject, minute, member) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        row.signal,
        row.subject,
        row.minute,
        member,
      );
    }
  }

  /** Events and by-route counts for one (signal, subject) with `minute > sinceMinute`. */
  private eventsInWindow(
    signal: SecurityAlertSignal,
    subject: string,
    sinceMinute: number,
    untilMinute = Number.MAX_SAFE_INTEGER,
  ): { events: number; byRoute: Record<string, number> } {
    const byRoute: Record<string, number> = {};
    let events = 0;
    const rows = this.sql.exec<MinuteCountsRow>(
      "SELECT minute, route, counts FROM buckets WHERE subject = ? AND minute > ? AND minute <= ?",
      subject,
      sinceMinute,
      untilMinute,
    );
    for (const r of rows) {
      const n = parseCounts(r.counts)[signal] ?? 0;
      if (n === 0) continue;
      events += n;
      byRoute[r.route] = (byRoute[r.route] ?? 0) + n;
    }
    return { events, byRoute };
  }

  private distinctMembers(signal: SecurityAlertSignal, subject: string, sinceMinute: number, untilMinute: number): number {
    return this.sql
      .exec<CountRow>(
        "SELECT COUNT(DISTINCT member) AS n FROM members WHERE signal = ? AND subject = ? AND minute > ? AND minute <= ?",
        signal,
        subject,
        sinceMinute,
        untilMinute,
      )
      .one().n;
  }

  /** Steps 3–4: over threshold and not reported within the window → queue a report. */
  private evaluate(signal: SecurityAlertSignal, subject: string, nowMs: number): boolean {
    const rule = RULES.get(signal);
    if (rule === undefined) return false;
    const nowMinute = Math.floor(nowMs / MINUTE_MS);
    const sinceMinute = nowMinute - rule.windowMinutes;
    const { events, byRoute } = this.eventsInWindow(signal, subject, sinceMinute);
    const observed = rule.measure === "events" ? events : this.distinctMembers(signal, subject, sinceMinute, nowMinute);
    if (observed < rule.threshold) return false;
    const windowMs = rule.windowMinutes * MINUTE_MS;
    const last = this.sql
      .exec<{ at_ms: number }>("SELECT at_ms FROM last_report WHERE signal = ? AND subject = ?", signal, subject)
      .toArray()[0];
    if (last !== undefined && last.at_ms > nowMs - windowMs) return false;
    this.sql.exec(
      `INSERT INTO last_report (signal, subject, at_ms) VALUES (?, ?, ?)
       ON CONFLICT(signal, subject) DO UPDATE SET at_ms = excluded.at_ms`,
      signal,
      subject,
      nowMs,
    );
    return this.queueReport(
      {
        signal,
        signalClass: rule.signalClass,
        subjectKind: rule.subject,
        subject,
        windowStartMs: (sinceMinute + 1) * MINUTE_MS,
        windowEndMs: nowMs,
        observed,
        events,
        threshold: rule.threshold,
        severity: rule.severity,
        byRoute,
      },
      nowMs,
    );
  }

  /** Merge into a pending report for the same (signal, subject), count past the cap, or insert. */
  private queueReport(report: CounterReport, nowMs: number): boolean {
    const rkey = `${report.signal}|${report.subject}`;
    const pending = this.sql.exec<ReportRow>("SELECT id, report, attempts FROM reports WHERE rkey = ?", rkey).toArray()[0];
    if (pending !== undefined) {
      const merged = mergeReports(JSON.parse(pending.report) as CounterReport, report);
      this.sql.exec("UPDATE reports SET report = ? WHERE id = ?", JSON.stringify(merged), pending.id);
      return false;
    }
    if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM reports").one().n >= MAX_PENDING_REPORTS) {
      this.addReportsOverflow(report.signalClass);
      return false;
    }
    this.sql.exec(
      "INSERT INTO reports (rkey, report, attempts, next_ms) VALUES (?, ?, 0, ?)",
      rkey,
      JSON.stringify(report),
      nowMs,
    );
    return true;
  }

  private addReportsOverflow(signalClass: SignalClass): void {
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES (?, '1')
       ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)`,
      `reports_overflow:${signalClass}`,
    );
  }

  private readReportsOverflow(): Partial<Record<SignalClass, number>> {
    const out: Partial<Record<SignalClass, number>> = {};
    for (const signalClass of Object.keys(CLASS_POLICY) as SignalClass[]) {
      const row = this.sql.exec<MetaRow>("SELECT v FROM meta WHERE k = ?", `reports_overflow:${signalClass}`).toArray()[0];
      if (row !== undefined) out[signalClass] = Number(row.v);
    }
    return out;
  }

  /**
   * RPC, `site` only (§2.4): summary-class events and overflow for the ledger's
   * digest, over the HALF-OPEN minutes `[fromMinute, toMinute)`, so consecutive
   * digests never count their shared boundary minute twice (audit M-5).
   */
  async summarise(fromMinute: number, toMinute: number): Promise<SiteSummary> {
    const activity: Record<string, SignalActivity> = {};
    for (const rule of SIGNAL_RULES) {
      if (rule.subject !== "site" || CLASS_POLICY[rule.signalClass].mode !== "summary") continue;
      activity[rule.signal] = { events: this.eventsInWindow(rule.signal, "site", fromMinute - 1, toMinute - 1).events };
    }
    const overflow = this.sql
      .exec<CountRow>("SELECT COALESCE(SUM(n), 0) AS n FROM overflow WHERE minute >= ? AND minute < ?", fromMinute, toMinute)
      .one().n;
    return { activity, overflowEvents: overflow };
  }

  async alarm(): Promise<void> {
    await this.alarmAt(Date.now());
  }

  /** The alarm with an explicit clock: report, prune, then empty or re-arm (§2.4). */
  async alarmAt(nowMs: number): Promise<void> {
    await this.deliverReports(nowMs);
    this.prune(nowMs);
    if (this.isEmpty()) {
      await this.ctx.storage.deleteAll();
      // `deleteAll` drops the tables too; the next `record` needs them.
      this.ensureSchema();
      return;
    }
    const next = this.sql.exec<{ next_ms: number | null }>("SELECT MIN(next_ms) AS next_ms FROM reports").one().next_ms;
    await this.armAt(Math.min(next ?? Number.MAX_SAFE_INTEGER, nowMs + IDLE_ALARM_MS));
  }

  /**
   * Alarm steps 1–2: one RPC with up to 500 due reports; on failure keep them,
   * back off, log.
   *
   * ⚠️ NO DELETE-AFTER-AWAIT ON STATE THAT MAY HAVE CHANGED (audit I-2). The
   * RPC's await opens the input gate, so a `record` can run meanwhile. The rows
   * being sent are DETACHED first (their merge key becomes `inflight:<id>`), so
   * a crossing arriving during the call lands in a NEW row and survives; the
   * overflow counts sent are SUBTRACTED, not deleted.
   */
  private async deliverReports(nowMs: number): Promise<void> {
    const due = this.sql
      .exec<ReportRow>("SELECT id, report, attempts FROM reports WHERE next_ms <= ? ORDER BY id LIMIT ?", nowMs, REPORTS_PER_CALL)
      .toArray();
    const countedOverflow = this.readReportsOverflow();
    if (due.length === 0 && Object.keys(countedOverflow).length === 0) return;
    this.ctx.storage.transactionSync(() => {
      for (const r of due) this.sql.exec("UPDATE reports SET rkey = ? WHERE id = ?", `inflight:${r.id}`, r.id);
    });
    try {
      await this.ledgerFor().report({ reports: due.map((r) => JSON.parse(r.report) as CounterReport), countedOverflow });
    } catch {
      this.ctx.storage.transactionSync(() => this.reattach(due, nowMs));
      logSecurityEvent({ kind: "alerting_fault", route: "security-ledger", reason: "ledger_unreachable", ip: null });
      return;
    }
    this.ctx.storage.transactionSync(() => {
      for (const r of due) this.sql.exec("DELETE FROM reports WHERE id = ?", r.id);
      for (const [signalClass, n] of Object.entries(countedOverflow)) this.subtractOverflow(signalClass, n ?? 0);
    });
  }

  /** A failed send: each detached report backs off, merged into any crossing that arrived meanwhile. */
  private reattach(due: readonly ReportRow[], nowMs: number): void {
    for (const r of due) {
      const sent = JSON.parse(r.report) as CounterReport;
      const rkey = `${sent.signal}|${sent.subject}`;
      const live = this.sql.exec<ReportRow>("SELECT id, report, attempts FROM reports WHERE rkey = ?", rkey).toArray()[0];
      const report = live === undefined ? sent : mergeReports(sent, JSON.parse(live.report) as CounterReport);
      if (live !== undefined) this.sql.exec("DELETE FROM reports WHERE id = ?", live.id);
      this.sql.exec(
        "UPDATE reports SET rkey = ?, report = ?, attempts = ?, next_ms = ? WHERE id = ?",
        rkey,
        JSON.stringify(report),
        r.attempts + 1,
        nowMs + reportRetryDelayMs(r.attempts + 1),
        r.id,
      );
    }
  }

  private subtractOverflow(signalClass: string, n: number): void {
    const k = `reports_overflow:${signalClass}`;
    this.sql.exec("UPDATE meta SET v = CAST(CAST(v AS INTEGER) - ? AS TEXT) WHERE k = ?", n, k);
    this.sql.exec("DELETE FROM meta WHERE k = ? AND CAST(v AS INTEGER) <= 0", k);
  }

  /** Alarm step 3. */
  private prune(nowMs: number): void {
    const nowMinute = Math.floor(nowMs / MINUTE_MS);
    this.sql.exec("DELETE FROM buckets WHERE minute <= ?", nowMinute - COUNTER_RETENTION_MINUTES);
    this.sql.exec("DELETE FROM members WHERE minute <= ?", nowMinute - COUNTER_RETENTION_MINUTES);
    this.sql.exec("DELETE FROM last_report WHERE at_ms <= ?", nowMs - COUNTER_RETENTION_MINUTES * MINUTE_MS);
    this.sql.exec("DELETE FROM overflow WHERE minute <= ?", nowMinute - OVERFLOW_RETENTION_MINUTES);
  }

  /** Alarm step 4: every table but `meta` empty. A pending report keeps the instance alive. */
  private isEmpty(): boolean {
    for (const table of ["buckets", "members", "reports", "last_report", "overflow"]) {
      if (this.sql.exec<CountRow>(`SELECT COUNT(*) AS n FROM ${table}`).one().n > 0) return false;
    }
    return true;
  }
}

/** Two reports for one (signal, subject) while the ledger is down: events added, window widened (§2.4 m4). */
export function mergeReports(a: CounterReport, b: CounterReport): CounterReport {
  const byRoute: Record<string, number> = { ...a.byRoute };
  for (const [route, n] of Object.entries(b.byRoute)) byRoute[route] = (byRoute[route] ?? 0) + n;
  return {
    ...b,
    windowStartMs: Math.min(a.windowStartMs, b.windowStartMs),
    windowEndMs: Math.max(a.windowEndMs, b.windowEndMs),
    observed: Math.max(a.observed, b.observed),
    events: a.events + b.events,
    byRoute,
  };
}
```

- [ ] **Step 3: GREEN** once Task 11 exports the class: `…/api test -- test/security-counter-do.test.ts`. Mutation controls: (a) set `STUFFING_MEMBER_SKIP` to 0 — "11 → none" goes RED; (b) delete the `ensureSchema()` after `deleteAll()` — the retention test's later `record` throws; (c) delete the detach loop before the RPC — "a crossing that arrives during the ledger call" goes RED (executed); restore each.

### Task 9: `SecurityLedgerDO` — decisions, held subjects, refs, forget, the alarm

**Files:** create `apps/api/src/durable-objects/SecurityLedgerDO.ts`, `apps/api/src/security/{ledger-schema,ledger-store,ledger-held,ledger-messages,ledger-prune}.ts`, `apps/api/test/security-ledger-do.test.ts`.

**Produces:** RPCs `report(batch)`, `ensureAlarm()`, `forgetAccount(userId)` (N7 and m-e, in PR 1 by I-11), `accountIdsPage(limit)` (the sweep's wrapping page, P-17), `alarm()`; test entry points `reportAt`, `alarmAt`, `forgetAccountAt`; seams `sinkFactory`, `siteFor`, `armAt`; `LIVENESS_KEY = "security-ledger:ok"`, `SECURITY_ADMIN_URL` (`null` in PR 1 and PR 2), `DELIVER_PER_RUN = 20`, `OUTBOX_BACKOFF_MINUTES = [1, 5, 30]`, `TOMBSTONE_MS` (30 days); `PRUNE_CHUNK`, `PRUNE_CHUNKS_PER_RUN` (P-4).

Behaviour (§2.6): `report()` runs `decide` per crossing in one `transactionSync` (skipping an account crossing whose user has an unexpired tombstone) and always ensures an alarm afterwards; held rows are versioned from one sequence (F2), capped per class with eviction of the oldest covered row, then counted (F3, P-6's `held_n`); the held report is built at sequence S in one transaction, in `HELD_PRIORITY` order, 200 rows a query, to 64 KB; delivery deletes only rows at or below their named version and raises every class's watermark to `max(W, S)`. The alarm runs liveness, deliver, heartbeat, held report, digest, config (PR 2) and prune as **independent** steps, each logging `security: alerting_fault security-ledger <step>` on failure, then re-arms. The ledger never calls `deleteAll()`.

- [ ] **Step 1: RED.** PR 1's part of the file (PR 2 appends one `describe`, Task 18):

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLASS_POLICY, HELD_ROW_CAP, type SecurityAlertMessage } from "@thinkersjournal/shared";

import { LIVENESS_KEY } from "../src/durable-objects/SecurityLedgerDO";
import { ensureLedgerAlarm } from "../src/security/ledger-cron";
import { PRUNE_CHUNK, PRUNE_CHUNKS_PER_RUN } from "../src/security/ledger-prune";

import { capturingSink, crossing, freshLedger, HOUR, MINUTE, ofType, quiet, T0 } from "./helpers/security-do";

/**
 * `SecurityLedgerDO` (security-alerting spec §2.6). Pool
 * project; `sinkFactory` and `siteFor` replaced on the instance (spec §3.3).
 * Messages queued by one alarm are delivered by the next, so the helper runs
 * the alarm twice at the same instant.
 */
afterEach(() => vi.restoreAllMocks());

type Count = { n: number };

/** Polls `read` every 50 ms, at most 5 s, until it is non-null. Only for the one REAL-alarm test. */
async function eventually<T>(read: () => Promise<T | null>): Promise<T | null> {
  for (let i = 0; i < 100; i++) {
    const v = await read();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
const NINE_UTC = Date.parse("2026-10-07T09:00:00.000Z");
const noSite = { summarise: async () => ({ activity: {}, overflowEvents: 0 }) };

describe("sending, cooldowns and held subjects (C2)", () => {
  it("a suppressed subject survives the alarm and is named, with its count, by the next held report", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sink, sent } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      await ledger.reportAt({ reports: [crossing()], countedOverflow: {} }, T0); // send; cooldown 1 h
      await ledger.reportAt({ reports: [crossing({ events: 20 })], countedOverflow: {} }, T0 + MINUTE);
      await ledger.reportAt({ reports: [crossing({ events: 30 })], countedOverflow: {} }, T0 + 2 * MINUTE);
      await ledger.alarmAt(T0 + HOUR + 1_000); // prunes the expired cooldown row
      await ledger.reportAt({ reports: [crossing()], countedOverflow: {} }, T0 + HOUR + 2_000);
      await ledger.alarmAt(T0 + HOUR + 3_000);
      expect(ofType(sent, "alert")).toHaveLength(2);
      const held = ofType(sent, "held_report")[0];
      expect(held?.entries[0]).toMatchObject({ signal: "credential_stuffing", suppressed: 2, events: 50 });
    });
  });

  it("a held report the sink refuses 4 times is dropped; the held row survives and the next hour names it", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      let refusals = 0;
      const { sink, sent } = capturingSink((m) => m.type === "held_report" && refusals++ < 4);
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      await ledger.reportAt({ reports: [crossing(), crossing()], countedOverflow: {} }, T0);
      const queued = T0 + 1_000;
      await ledger.alarmAt(queued); // step 4 queues the held report, after this run's deliver step
      for (const at of [queued + 1, queued + 1 + MINUTE, queued + 1 + 6 * MINUTE, queued + 1 + 36 * MINUTE]) {
        await ledger.alarmAt(at);
      }
      expect(refusals).toBe(4);
      const heldReportsLeft = state.storage.sql
        .exec<Count>(`SELECT COUNT(*) AS n FROM outbox WHERE message LIKE '%"type":"held_report"%'`)
        .one().n;
      expect(heldReportsLeft).toBe(0);
      expect(state.storage.sql.exec<Count>("SELECT COUNT(*) AS n FROM held").one().n).toBe(1);
      await ledger.alarmAt(T0 + 2 * HOUR); // the next hour queues a fresh report …
      await ledger.alarmAt(T0 + 2 * HOUR + 1); // … delivered here
      expect(ofType(sent, "held_report")[0]?.entries[0]?.subject).toEqual({ kind: "ip_prefix", value: "2001:db8:1:2::/64" });
    });
  });

  it("I-7: nothing the ledger sends about an account carries its user id", async () => {
    const userId = "11111111-2222-4333-8444-555555555555";
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sink, sent } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      const acct = crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: userId });
      await ledger.reportAt({ reports: [acct, acct], countedOverflow: {} }, NINE_UTC);
      for (const t of [NINE_UTC + 1, NINE_UTC + 2]) await ledger.alarmAt(t);
      expect(new Set(sent.map((m) => m.type))).toEqual(new Set(["alert", "held_report", "heartbeat", "digest"])); // control
      expect(JSON.stringify(sent)).not.toContain(userId);
      expect(ofType(sent, "alert")[0]?.subject).toEqual({ kind: "account", ref: expect.stringMatching(/^[0-9a-f]{32}$/) });
    });
  });
});

describe("budgets (C1, decoys)", () => {
  it("the 7th ip_burst alert in a day is refused; exactly one budget_exhausted; the digest counts it", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sink, sent } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      const budget = CLASS_POLICY.ip_burst.dailyBudget;
      const reports = Array.from({ length: budget + 2 }, (_, i) =>
        crossing({ signal: "login_ip_burst", signalClass: "ip_burst", subject: `203.0.113.${i}`, threshold: 50 }),
      );
      await ledger.reportAt({ reports, countedOverflow: {} }, T0);
      await ledger.alarmAt(T0 + HOUR);
      await ledger.alarmAt(T0 + HOUR + 1);
      expect(ofType(sent, "alert")).toHaveLength(budget);
      expect(ofType(sent, "budget_exhausted")).toHaveLength(1);
      const line = ofType(sent, "digest")[0]?.classes.find((c) => c.signalClass === "ip_burst");
      expect(line?.suppressedByBudget).toBe(2);
    });
  });

  it("purge, storm and ip_burst exhausted → a targeted_account crossing is still sent", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sink, sent } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      const decoys = [
        ...Array.from({ length: 10 }, (_, i) => crossing({ signal: "login_ip_burst", signalClass: "ip_burst", subject: `198.51.100.${i}` })),
        crossing({ signal: "purge_secret_failure", signalClass: "purge", subjectKind: "site", subject: "site" }),
        crossing({ signal: "rate_limit_storm", signalClass: "storm", subjectKind: "site", subject: "site" }),
      ];
      await ledger.reportAt({ reports: decoys, countedOverflow: {} }, T0);
      const target = crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: "user-target" });
      await ledger.reportAt({ reports: [target], countedOverflow: {} }, T0 + 1);
      await ledger.alarmAt(T0 + 2);
      expect(ofType(sent, "alert").some((a) => a.signal === "targeted_account")).toBe(true);
    });
  });
});

describe("versions and coverage (F2)", () => {
  it("a subject that crosses again after the snapshot survives delivery and is named again", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      let deliverHeld = false;
      const { sink, sent } = capturingSink((m) => m.type === "held_report" && !deliverHeld);
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      await ledger.reportAt({ reports: [crossing(), crossing()], countedOverflow: {} }, T0); // send + hold
      await ledger.alarmAt(T0 + 1); // queues report #1, built at S
      await ledger.reportAt({ reports: [crossing({ events: 7 })], countedOverflow: {} }, T0 + 2); // re-crosses after S
      deliverHeld = true;
      await ledger.alarmAt(T0 + 3); // report #1 delivered
      expect(ofType(sent, "held_report")).toHaveLength(1);
      expect(state.storage.sql.exec<Count>("SELECT COUNT(*) AS n FROM held").one().n).toBe(1);
      await ledger.alarmAt(T0 + 2 * HOUR); // the next hour queues report #2 …
      await ledger.alarmAt(T0 + 2 * HOUR + 1); // … and this run delivers it
      const second = ofType(sent, "held_report")[1];
      expect(second?.entries[0]).toMatchObject({ signal: "credential_stuffing", events: 7 + 12 });
    });
  });
});

describe("row caps (F3, D6) and bounded reports (R1)", () => {
  it("25,000 stuffing decoys: 20,000 stored, 5,000 counted, one held_capped; the real target is named first", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const { sink, sent } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      const spend = Array.from({ length: 24 }, (_, i) => [
        crossing({ subject: `spend-s-${i}` }),
        crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: `spend-a-${i}` }),
      ]).flat();
      await ledger.reportAt({ reports: spend, countedOverflow: {} }, T0);
      for (let i = 0; i < 25_000; i += 500) {
        const batch = Array.from({ length: 500 }, (_, j) => crossing({ subject: `2001:db8:${(i + j).toString(16)}::/64` }));
        await ledger.reportAt({ reports: batch, countedOverflow: {} }, T0 + 1);
      }
      const target = crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: "user-real", events: 31 });
      await ledger.reportAt({ reports: [target], countedOverflow: {} }, T0 + 2);
      const stored = state.storage.sql.exec<Count>("SELECT COUNT(*) AS n FROM held WHERE signal_class = 'stuffing'").one().n;
      expect(stored).toBe(HELD_ROW_CAP.stuffing);
      await ledger.alarmAt(T0 + 3);
      await ledger.alarmAt(T0 + 4);
      expect(ofType(sent, "held_capped").filter((m) => m.signalClass === "stuffing")).toHaveLength(1);
      const report = ofType(sent, "held_report")[0];
      expect(report?.entries[0]?.signal).toBe("targeted_account");
      expect(JSON.stringify(report?.entries).length).toBeLessThanOrEqual(64 * 1024);
      expect(report?.countedNotStored.find((c) => c.signalClass === "stuffing")?.count).toBeGreaterThanOrEqual(5_000);
    });
  });
});

describe("pruning keeps up (F3; plan ruling P-4; audit I-1)", () => {
  it("a short chunk then a large target: every call stays inside its budget, and the backlog drains", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const { sink } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      const armed = quiet(ledger);
      const sql = state.storage.sql;
      sql.exec("INSERT INTO meta (k, v) VALUES ('w:account', '100000'), ('held_n:account', '4500')");
      for (let i = 0; i < 4_500; i++) {
        sql.exec(
          `INSERT INTO held (signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version, updated_ms)
           VALUES ('account', ?, 'targeted_account', 'account', ?, 1, 1, ?, ?)`,
          `targeted_account|a${i}`,
          `a${i}`,
          i + 1,
          T0 - 8 * 86_400_000,
        );
      }
      for (let i = 0; i < 6_000; i++) sql.exec("INSERT INTO cooldowns (signal, subject, until_ms) VALUES ('login_ip_burst', ?, ?)", `c${i}`, T0 - 1);
      const rows = () =>
        sql.exec<Count>("SELECT (SELECT COUNT(*) FROM held) + (SELECT COUNT(*) FROM cooldowns) AS n").one().n;
      const perCall: number[] = [];
      for (let run = 0; run < 10 && rows() > 0; run++) {
        const before = rows();
        await ledger.alarmAt(T0 + run);
        perCall.push(before - rows());
      }
      expect(rows()).toBe(0);
      for (const n of perCall) expect(n).toBeLessThanOrEqual(PRUNE_CHUNK * PRUNE_CHUNKS_PER_RUN);
      expect(perCall).toEqual([4_500, 5_000, 1_000]);
      expect(armed.length).toBeGreaterThan(0);
    });
  });

  it("10,000 aged covered rows: one alarm prunes its chunk budget and re-arms for now; the next finishes", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const { sink } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      const sql = state.storage.sql;
      sql.exec("INSERT INTO meta (k, v) VALUES ('w:stuffing', '20000')");
      for (let i = 0; i < 10_000; i++) {
        sql.exec(
          `INSERT INTO held (signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version, updated_ms)
           VALUES ('stuffing', ?, 'credential_stuffing', 'ip', ?, 1, 1, ?, ?)`,
          `credential_stuffing|s${i}`,
          `s${i}`,
          i + 1,
          T0 - 8 * 86_400_000,
        );
      }
      sql.exec("INSERT INTO meta (k, v) VALUES ('held_n:stuffing', '10000')");
      const armed = quiet(ledger);
      await ledger.alarmAt(T0);
      expect(sql.exec<Count>("SELECT COUNT(*) AS n FROM held").one().n).toBe(10_000 - PRUNE_CHUNK * PRUNE_CHUNKS_PER_RUN);
      expect(armed.at(-1)).toBe(T0); // work remains → re-armed for NOW
      await ledger.alarmAt(T0 + 1);
      expect(sql.exec<Count>("SELECT COUNT(*) AS n FROM held").one().n).toBe(0);
      expect(sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'held_n:stuffing'").one().v).toBe("0");
    });
  });
});

describe("independent steps (R1), heartbeat (N2) and liveness (R2)", () => {
  it("with the DELIVER step throwing and summarise failing, the later steps still run and the KV key is written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      ledger.sinkFactory = () => {
        throw new Error("sink construction failed"); // deliver() throws before any send
      };
      ledger.siteFor = () => ({
        summarise: async () => {
          throw new Error("site down");
        },
      });
      quiet(ledger);
      await ledger.reportAt({ reports: [crossing(), crossing()], countedOverflow: {} }, NINE_UTC);
      await ledger.alarmAt(NINE_UTC + 1);
      expect(warn.mock.calls.some((c) => c[0] === "security: alerting_fault security-ledger deliver")).toBe(true);
      const queued = state.storage.sql
        .exec<{ message: string }>("SELECT message FROM outbox")
        .toArray()
        .map((r) => (JSON.parse(r.message) as SecurityAlertMessage).type);
      expect(queued).toEqual(expect.arrayContaining(["alert", "heartbeat", "held_report", "digest"]));
      const digest = state.storage.sql
        .exec<{ message: string }>(`SELECT message FROM outbox WHERE message LIKE '%"type":"digest"%'`)
        .one().message;
      expect(digest).toContain('"siteSummaryUnavailable":true');
      expect(await env.HEALTH.get(LIVENESS_KEY)).toBe(String(NINE_UTC + 1));
    });
  });

  it("a quiet day → exactly one heartbeat with lateMinutes 0; first alarm at 10:05 → lateMinutes 65", async () => {
    const runs: readonly (readonly [readonly number[], number])[] = [
      [[NINE_UTC - 1, NINE_UTC, NINE_UTC + 1, NINE_UTC + 2 * HOUR], 0],
      [[NINE_UTC + 65 * MINUTE, NINE_UTC + 65 * MINUTE + 1, NINE_UTC + 3 * HOUR], 65],
    ];
    for (const [times, late] of runs) {
      await runInDurableObject(freshLedger(), async (ledger) => {
        const { sink, sent } = capturingSink();
        ledger.sinkFactory = () => sink;
        ledger.siteFor = () => noSite;
        quiet(ledger);
        for (const t of times) await ledger.alarmAt(t);
        const beats = ofType(sent, "heartbeat");
        expect(beats).toHaveLength(1);
        expect(beats[0]?.lateMinutes).toBe(late);
      });
    }
  });

  it("report() with nothing queued still arms an alarm (N2)", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const armed = quiet(ledger);
      await ledger.reportAt({ reports: [], countedOverflow: {} }, T0);
      expect(armed).toHaveLength(1);
    });
  });

  it("the cron's ensureLedgerAlarm sets an alarm on the real `ledger` when none is set", async () => {
    // The production instance name: ensureLedgerAlarm takes no name, by design (m-d).
    const stub = env.SECURITY_LEDGER.getByName("ledger");
    await runInDurableObject(stub, (_l, state) => state.storage.deleteAlarm());
    await ensureLedgerAlarm(env);
    // A REAL alarm, set for now: it may already have run and re-armed, so poll (bounded) for "set".
    expect(await eventually(() => runInDurableObject(stub, (_l, state) => state.storage.getAlarm()))).not.toBeNull();
  });

  it("ensureAlarm leaves an alarm that is already set alone (a second cron call changes nothing)", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      const far = Date.now() + 30 * 86_400_000;
      await state.storage.setAlarm(far);
      await ledger.ensureAlarm();
      await ledger.ensureAlarm();
      expect(await state.storage.getAlarm()).toBe(far);
    });
  });
});

describe("undeliverable", () => {
  it("after 4 failures the message is logged in full through the log sink, dropped, and counted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      let refuse = true;
      const { sink, sent } = capturingSink((m: SecurityAlertMessage) => refuse && m.type === "alert");
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      await ledger.reportAt({ reports: [crossing()], countedOverflow: {} }, T0);
      let now = T0;
      for (const step of [0, 1, 5, 30]) {
        now += step * MINUTE;
        await ledger.alarmAt(now);
      }
      expect(state.storage.sql.exec<Count>("SELECT COUNT(*) AS n FROM outbox WHERE message LIKE '%\"type\":\"alert\"%'").one().n).toBe(0);
      expect(warn.mock.calls.some((c) => c[0] === "security-alert: alert")).toBe(true);
      refuse = false;
      await ledger.alarmAt(T0 + 2 * HOUR); // queues the next hour's digest …
      await ledger.alarmAt(T0 + 2 * HOUR + 1); // … delivered here
      expect(ofType(sent, "digest").at(-1)?.undeliverable).toBe(1);
    });
  });
});

/** Forget and tombstone (N7, m-e) — PR 1, with the ledger (audit I-11). */
describe("forgetAccount", () => {
  it("deletes refs, held rows and cooldowns; a late report re-creates nothing; after 30 days it would", async () => {
    await runInDurableObject(freshLedger(), async (ledger, state) => {
      quiet(ledger);
      const acct = crossing({ signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: "user-x" });
      await ledger.reportAt({ reports: [acct, acct], countedOverflow: {} }, T0);
      const rows = () =>
        state.storage.sql
          .exec<Count>(
            `SELECT (SELECT COUNT(*) FROM account_refs) + (SELECT COUNT(*) FROM held) + (SELECT COUNT(*) FROM cooldowns) AS n`,
          )
          .one().n;
      expect(rows()).toBe(3);
      await ledger.forgetAccountAt("user-x", T0 + 1);
      await ledger.forgetAccountAt("user-x", T0 + 2); // twice is harmless
      expect(rows()).toBe(0);
      await ledger.reportAt({ reports: [acct], countedOverflow: {} }, T0 + 3);
      expect(rows()).toBe(0);
      await ledger.reportAt({ reports: [acct], countedOverflow: {} }, T0 + 31 * 86_400_000);
      expect(rows()).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: Implement.** Tables (P-6):

```ts
/**
 * `SecurityLedgerDO`'s tables (security-alerting spec §2.6, "Storage and
 * retention"). Additions to the spec's illustrative DDL (§8: not executed), each
 * one a column the spec's prose needs but its list omits:
 * - `held.subject_kind`: an account row is rendered as a ref, an ip row as a prefix.
 * - `class_day.suppressed`: `budget_exhausted.suppressedSoFar` (§3.2).
 * - `class_period`: the digest's per-class counts since the last digest (§2.6 step 5).
 * - `outbox.covers`: a held report's `S` and each named row's key and version (§2.6, F2).
 */
export const LEDGER_SCHEMA: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
  `CREATE TABLE IF NOT EXISTS held (signal_class TEXT NOT NULL, subject_key TEXT NOT NULL, signal TEXT NOT NULL,
     subject_kind TEXT NOT NULL, subject TEXT NOT NULL, events INTEGER NOT NULL, suppressed INTEGER NOT NULL,
     version INTEGER NOT NULL, updated_ms INTEGER NOT NULL, PRIMARY KEY (signal_class, subject_key)) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS held_class_version ON held (signal_class, version)",
  // R2-1: forgetAccount and the nightly sweep find an account's rows without scanning `held`.
  "CREATE INDEX IF NOT EXISTS held_subject ON held (subject_kind, subject)",
  `CREATE TABLE IF NOT EXISTS held_overflow (signal_class TEXT NOT NULL, day TEXT NOT NULL, counted INTEGER NOT NULL,
     PRIMARY KEY (signal_class, day)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS cooldowns (signal TEXT NOT NULL, subject TEXT NOT NULL, until_ms INTEGER NOT NULL,
     PRIMARY KEY (signal, subject)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS class_day (class TEXT NOT NULL, day TEXT NOT NULL, sent INTEGER NOT NULL,
     onset_signals TEXT NOT NULL, exhausted_queued INTEGER NOT NULL, suppressed INTEGER NOT NULL,
     PRIMARY KEY (class, day)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS class_period (class TEXT PRIMARY KEY, sent INTEGER NOT NULL,
     by_cooldown INTEGER NOT NULL, by_budget INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, message TEXT NOT NULL, covers TEXT,
     attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS account_refs (user_id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE,
     last_used_ms INTEGER NOT NULL) WITHOUT ROWID`,
  // PR 2 (§2.6 m-e): an anonymised account's tombstone, so a late report cannot re-create its rows.
  "CREATE TABLE IF NOT EXISTS forgotten (user_id TEXT PRIMARY KEY, until_ms INTEGER NOT NULL) WITHOUT ROWID",
];
```

Typed SQL access, all synchronous:

```ts
/**
 * Typed access to `SecurityLedgerDO`'s SQLite tables (security-alerting spec
 * §2.6). Every method is synchronous, so callers can compose them inside one
 * `transactionSync`. No method makes an RPC or awaits anything.
 */
import type { SecurityAlertMessage, SignalClass } from "@thinkersjournal/shared";

const DAY_MS = 86_400_000;
/** An account ref is forgotten this long after the last message that named it (§2.6). */
export const REF_TTL_MS = 7 * DAY_MS;

type MetaRow = { v: string };
type ClassDayRow = { sent: number; onset_signals: string; exhausted_queued: number; suppressed: number };
type UntilRow = { until_ms: number };
type RefRow = { ref: string };
type CountRow = { n: number };

export interface ClassDay {
  readonly sent: number;
  readonly onsetSignals: readonly string[];
  readonly exhaustedQueued: boolean;
  readonly suppressed: number;
}

export type PeriodField = "sent" | "by_cooldown" | "by_budget";

/** `YYYY-MM-DD`, UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 32 lowercase hex characters from 16 CSPRNG bytes: the opaque account ref (§2.6). */
export function newRef(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class LedgerStore {
  constructor(readonly sql: SqlStorage) {}

  meta(k: string): string | null {
    return this.sql.exec<MetaRow>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  setMeta(k: string, v: string): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  metaNumber(k: string): number {
    return Number(this.meta(k) ?? "0");
  }

  addMeta(k: string, by: number): number {
    const next = this.metaNumber(k) + by;
    this.setMeta(k, String(next));
    return next;
  }

  /** The ledger's one monotonic sequence (F2). Versions come from here, never from a clock. */
  nextVersion(): number {
    return this.addMeta("seq", 1);
  }

  currentVersion(): number {
    return this.metaNumber("seq");
  }

  /** The class's coverage watermark `W`: rows with `version` ≤ W are covered. */
  watermark(signalClass: SignalClass): number {
    return this.metaNumber(`w:${signalClass}`);
  }

  /** `W = max(W, S)`: never moves back, even if an older report is delivered after a newer one (m1). */
  raiseWatermark(signalClass: SignalClass, s: number): void {
    if (s > this.watermark(signalClass)) this.setMeta(`w:${signalClass}`, String(s));
  }

  classDay(signalClass: SignalClass, day: string): ClassDay {
    const row = this.sql
      .exec<ClassDayRow>(
        "SELECT sent, onset_signals, exhausted_queued, suppressed FROM class_day WHERE class = ? AND day = ?",
        signalClass,
        day,
      )
      .toArray()[0];
    if (row === undefined) return { sent: 0, onsetSignals: [], exhaustedQueued: false, suppressed: 0 };
    return {
      sent: row.sent,
      onsetSignals: JSON.parse(row.onset_signals) as string[],
      exhaustedQueued: row.exhausted_queued === 1,
      suppressed: row.suppressed,
    };
  }

  saveClassDay(signalClass: SignalClass, day: string, d: ClassDay): void {
    this.sql.exec(
      `INSERT INTO class_day (class, day, sent, onset_signals, exhausted_queued, suppressed) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(class, day) DO UPDATE SET sent = excluded.sent, onset_signals = excluded.onset_signals,
         exhausted_queued = excluded.exhausted_queued, suppressed = excluded.suppressed`,
      signalClass,
      day,
      d.sent,
      JSON.stringify(d.onsetSignals),
      d.exhaustedQueued ? 1 : 0,
      d.suppressed,
    );
  }

  cooldownUntil(signal: string, subject: string): number | null {
    return (
      this.sql.exec<UntilRow>("SELECT until_ms FROM cooldowns WHERE signal = ? AND subject = ?", signal, subject).toArray()[0]
        ?.until_ms ?? null
    );
  }

  setCooldown(signal: string, subject: string, untilMs: number): void {
    this.sql.exec(
      `INSERT INTO cooldowns (signal, subject, until_ms) VALUES (?, ?, ?)
       ON CONFLICT(signal, subject) DO UPDATE SET until_ms = excluded.until_ms`,
      signal,
      subject,
      untilMs,
    );
  }

  addPeriod(signalClass: SignalClass, field: PeriodField): void {
    this.sql.exec(
      `INSERT INTO class_period (class, sent, by_cooldown, by_budget) VALUES (?, 0, 0, 0)
       ON CONFLICT(class) DO NOTHING`,
      signalClass,
    );
    this.sql.exec(`UPDATE class_period SET ${field} = ${field} + 1 WHERE class = ?`, signalClass);
  }

  period(signalClass: SignalClass): Record<PeriodField, number> {
    const row = this.sql
      .exec<Record<PeriodField, number>>("SELECT sent, by_cooldown, by_budget FROM class_period WHERE class = ?", signalClass)
      .toArray()[0];
    return row ?? { sent: 0, by_cooldown: 0, by_budget: 0 };
  }

  resetPeriod(): void {
    this.sql.exec("DELETE FROM class_period");
  }

  /** The account's ref: reused while it keeps appearing, refreshed on every use (§2.6). */
  refFor(userId: string, nowMs: number): string {
    const found = this.sql.exec<RefRow>("SELECT ref FROM account_refs WHERE user_id = ?", userId).toArray()[0];
    const ref = found?.ref ?? newRef();
    this.sql.exec(
      `INSERT INTO account_refs (user_id, ref, last_used_ms) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_used_ms = excluded.last_used_ms`,
      userId,
      ref,
      nowMs,
    );
    return ref;
  }

  /** Queue one message for the alarm's delivery step. `covers` is set on held reports only. */
  queue(message: SecurityAlertMessage, nowMs: number, covers: string | null = null): void {
    this.sql.exec(
      "INSERT INTO outbox (message, covers, attempts, next_ms) VALUES (?, ?, 0, ?)",
      JSON.stringify(message),
      covers,
      nowMs,
    );
  }

  count(sqlText: string, ...bindings: (string | number)[]): number {
    return this.sql.exec<CountRow>(sqlText, ...bindings).one().n;
  }
}
```

Held subjects (R1, F2, F3):

```ts
/**
 * Held subjects: one row each, versioned, capped, reported in bounded pages
 * (security-alerting spec §2.6, R1/F2/F3). Synchronous; callers run these inside
 * `transactionSync`.
 */
import {
  HELD_PAGE_SIZE,
  HELD_PRIORITY,
  HELD_ROW_CAP,
  HeldReportBuilder,
  SIGNAL_RULES,
  type CounterReport,
  type SecurityAlertSignal,
  type SecurityAlertSubject,
  type SecurityHeldReport,
  type SignalClass,
  type SubjectKind,
} from "@thinkersjournal/shared";

import { utcDay, type LedgerStore } from "./ledger-store";

type HeldRow = {
  signal_class: string;
  subject_key: string;
  signal: string;
  subject_kind: string;
  subject: string;
  events: number;
  suppressed: number;
  version: number;
};

/** One named row a held report covers: its class, key and the version it was named at. */
export type CoveredRow = readonly [SignalClass, string, number];

export interface HeldCovers {
  readonly s: number;
  readonly rows: readonly CoveredRow[];
}

const CLASS_OF: ReadonlyMap<string, SignalClass> = new Map(SIGNAL_RULES.map((r) => [r.signal, r.signalClass]));

/** How a raw subject appears in a message: a ref for an account, never a user id (§3.2 I7). */
export function renderSubject(
  store: LedgerStore,
  kind: SubjectKind | string,
  subject: string,
  nowMs: number,
): SecurityAlertSubject {
  if (kind === "account") return { kind: "account", ref: store.refFor(subject, nowMs) };
  if (kind === "site") return { kind: "site" };
  return subject === "none" ? { kind: "no_ip" } : { kind: "ip_prefix", value: subject };
}

/** Stored rows per class, kept exact by `deleteHeld` and the insert below (no per-insert COUNT scan). */
export function heldStored(store: LedgerStore, signalClass: SignalClass): number {
  return store.metaNumber(`held_n:${signalClass}`);
}

/**
 * THE ONE WAY a held row is deleted, so each class's stored count stays exact.
 * `where` is a fixed SQL fragment from this module or the ledger, never input.
 */
export function deleteHeld(store: LedgerStore, where: string, ...bindings: (string | number)[]): number {
  const gone = store.sql.exec<{ signal_class: string }>(`DELETE FROM held WHERE ${where} RETURNING signal_class`, ...bindings).toArray();
  const byClass = new Map<string, number>();
  for (const r of gone) byClass.set(r.signal_class, (byClass.get(r.signal_class) ?? 0) + 1);
  for (const [c, n] of byClass) store.addMeta(`held_n:${c}`, -n);
  return gone.length;
}

/**
 * A suppressed crossing: update its row in place, or insert it if the class has
 * room, or evict the class's oldest COVERED row, or — every row still open —
 * count it in `held_overflow` (F3). Returns true when this was the class's first
 * counted subject today, so the caller queues `held_capped`.
 */
export function upsertHeld(store: LedgerStore, r: CounterReport, nowMs: number): boolean {
  const key = `${r.signal}|${r.subject}`;
  const updated = store.sql.exec(
    `UPDATE held SET events = events + ?, suppressed = suppressed + 1, version = ?, updated_ms = ?
     WHERE signal_class = ? AND subject_key = ?`,
    r.events,
    store.nextVersion(),
    nowMs,
    r.signalClass,
    key,
  ).rowsWritten;
  if (updated > 0) return false;
  if (!hasRoom(store, r.signalClass)) return countOverflow(store, r.signalClass, nowMs);
  store.sql.exec(
    `INSERT INTO held (signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    r.signalClass,
    key,
    r.signal,
    r.subjectKind,
    r.subject,
    r.events,
    store.nextVersion(),
    nowMs,
  );
  store.addMeta(`held_n:${r.signalClass}`, 1);
  return false;
}

/** Room for one more row, evicting the oldest covered row (lowest version ≤ W) if the class is full. */
function hasRoom(store: LedgerStore, signalClass: SignalClass): boolean {
  if (heldStored(store, signalClass) < HELD_ROW_CAP[signalClass]) return true;
  const evicted = deleteHeld(
    store,
    `(signal_class, subject_key) IN (
       SELECT signal_class, subject_key FROM held WHERE signal_class = ? AND version <= ? ORDER BY version LIMIT 1)`,
    signalClass,
    store.watermark(signalClass),
  );
  return evicted > 0;
}

/** Count, not store. True on the class's first such count today. */
export function countOverflow(store: LedgerStore, signalClass: SignalClass, nowMs: number, by = 1): boolean {
  const day = utcDay(nowMs);
  const before = countedToday(store, signalClass, day);
  store.sql.exec(
    `INSERT INTO held_overflow (signal_class, day, counted) VALUES (?, ?, ?)
     ON CONFLICT(signal_class, day) DO UPDATE SET counted = counted + excluded.counted`,
    signalClass,
    day,
    by,
  );
  return before === 0;
}

export function countedToday(store: LedgerStore, signalClass: SignalClass, day: string): number {
  return store.count(
    "SELECT COALESCE(SUM(counted), 0) AS n FROM held_overflow WHERE signal_class = ? AND day = ?",
    signalClass,
    day,
  );
}

export function openCount(store: LedgerStore, signalClass: SignalClass): number {
  return store.count(
    "SELECT COUNT(*) AS n FROM held WHERE signal_class = ? AND version > ?",
    signalClass,
    store.watermark(signalClass),
  );
}

/** Every class that can hold rows, in no particular order. */
export const HELD_CLASSES: readonly SignalClass[] = (Object.keys(HELD_ROW_CAP) as SignalClass[]).filter(
  (c) => HELD_ROW_CAP[c] > 0,
);

/** One page of a signal's open rows: uncapped events, most first; keyset on (events, key). */
function openPage(store: LedgerStore, signal: SecurityAlertSignal, after: HeldRow | null): HeldRow[] {
  const signalClass = CLASS_OF.get(signal);
  if (signalClass === undefined) return [];
  return store.sql
    .exec<HeldRow>(
      `SELECT signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version FROM held
       WHERE signal_class = ? AND signal = ? AND version > ?
         AND (? IS NULL OR events < ? OR (events = ? AND subject_key > ?))
       ORDER BY events DESC, subject_key ASC LIMIT ?`,
      signalClass,
      signal,
      store.watermark(signalClass),
      after === null ? null : 1,
      after?.events ?? 0,
      after?.events ?? 0,
      after?.subject_key ?? "",
      HELD_PAGE_SIZE,
    )
    .toArray();
}

/**
 * Build the held-subject report at sequence value S (R1). Pages `held` in
 * `HELD_PRIORITY` order, 200 rows a query, until the 64 KB byte cap; everything
 * after the first refusal is counted in `more`. Returns null when nothing is open.
 */
export function buildHeldReport(
  store: LedgerStore,
  period: { readonly startMs: number; readonly endMs: number },
  adminUrl: string | null,
): { readonly report: SecurityHeldReport; readonly covers: HeldCovers } | null {
  const s = store.currentVersion();
  const open = new Map(HELD_CLASSES.map((c) => [c, openCount(store, c)] as const));
  if ([...open.values()].every((n) => n === 0)) return null;
  const builder = new HeldReportBuilder();
  const rows: CoveredRow[] = [];
  const named = new Map<SignalClass, number>();
  pageAll(store, period.endMs, builder, rows, named);
  const day = utcDay(period.endMs);
  return {
    report: {
      type: "held_report",
      periodStart: new Date(period.startMs).toISOString(),
      periodEnd: new Date(period.endMs).toISOString(),
      entries: builder.entries,
      more: HELD_CLASSES.map((c) => ({ signalClass: c, count: (open.get(c) ?? 0) - (named.get(c) ?? 0) })).filter(
        (m) => m.count > 0,
      ),
      adminUrl,
      countedNotStored: HELD_CLASSES.map((c) => ({ signalClass: c, count: countedToday(store, c, day) })).filter(
        (m) => m.count > 0,
      ),
    },
    covers: { s, rows },
  };
}

function pageAll(
  store: LedgerStore,
  nowMs: number,
  builder: HeldReportBuilder,
  rows: CoveredRow[],
  named: Map<SignalClass, number>,
): void {
  for (const signal of HELD_PRIORITY) {
    let after: HeldRow | null = null;
    for (;;) {
      const page = openPage(store, signal, after);
      for (const row of page) {
        const signalClass = row.signal_class as SignalClass;
        const entry = {
          signal: row.signal as SecurityAlertSignal,
          subject: renderSubject(store, row.subject_kind, row.subject, nowMs),
          events: row.events,
          suppressed: row.suppressed,
        };
        if (!builder.tryAdd(entry)) return;
        rows.push([signalClass, row.subject_key, row.version]);
        named.set(signalClass, (named.get(signalClass) ?? 0) + 1);
      }
      const last = page.at(-1);
      if (last === undefined || page.length < HELD_PAGE_SIZE) break;
      after = last;
    }
  }
}

/** Keys per DELETE statement on delivery (§2.6 F2: "in statements of at most 100 keys"). */
export const COVER_DELETE_CHUNK = 100;

/**
 * A held report was DELIVERED: delete each named row only if its version is at
 * or below the version the report named, then raise every class's watermark to S.
 */
export function applyCoverage(store: LedgerStore, covers: HeldCovers): void {
  for (let i = 0; i < covers.rows.length; i += COVER_DELETE_CHUNK) {
    const chunk = covers.rows.slice(i, i + COVER_DELETE_CHUNK);
    const where = chunk.map(() => "(signal_class = ? AND subject_key = ? AND version <= ?)").join(" OR ");
    deleteHeld(store, where, ...chunk.flat());
  }
  for (const c of HELD_CLASSES) store.raiseWatermark(c, covers.s);
}
```

Message builders:

```ts
/**
 * The ledger's message builders (security-alerting spec §3.2). Pure apart from
 * reading counts through `LedgerStore`; every message is bounded and carries
 * no user id and no address (§3.2 I7).
 */
import {
  CLASS_POLICY,
  SIGNAL_RULES,
  type CounterReport,
  type DigestClassLine,
  type SecurityAlert,
  type SecurityAlertSubject,
  type SecurityDigest,
  type SecurityHeartbeat,
  type SignalClass,
  type SiteSummary,
} from "@thinkersjournal/shared";

import { countedToday, HELD_CLASSES, heldStored, openCount } from "./ledger-held";
import { utcDay, type LedgerStore } from "./ledger-store";

const ALL_CLASSES = Object.keys(CLASS_POLICY) as SignalClass[];
/** The heartbeat's hour (§2.6 step 3): the first alarm at or after 09:00 UTC. */
export const HEARTBEAT_HOUR_UTC = 9;

export function alertFrom(r: CounterReport, subject: SecurityAlertSubject, versionId: string | null): SecurityAlert {
  return {
    type: "alert",
    signal: r.signal,
    signalClass: r.signalClass,
    severity: r.severity,
    subject,
    windowStart: new Date(r.windowStartMs).toISOString(),
    windowEnd: new Date(r.windowEndMs).toISOString(),
    observed: r.observed,
    events: r.events,
    threshold: r.threshold,
    byRoute: r.byRoute,
    versionId,
  };
}

/** Fixed size: one line per class, whatever an attacker does (§2.6 step 3). */
export function heartbeatFrom(store: LedgerStore, nowMs: number): SecurityHeartbeat {
  const day = utcDay(nowMs);
  const nineUtc = Date.parse(`${day}T${String(HEARTBEAT_HOUR_UTC).padStart(2, "0")}:00:00.000Z`);
  return {
    type: "heartbeat",
    day,
    lateMinutes: Math.max(0, Math.floor((nowMs - nineUtc) / 60_000)),
    totals: ALL_CLASSES.map((c) => ({
      signalClass: c,
      sent: store.classDay(c, day).sent,
      held: heldStored(store, c),
    })),
  };
}

function activityFor(c: SignalClass, site: SiteSummary | null): DigestClassLine["activity"] {
  if (site === null || CLASS_POLICY[c].mode !== "summary") return {};
  const out: Record<string, { events: number }> = {};
  for (const rule of SIGNAL_RULES) {
    const a = site.activity[rule.signal];
    if (rule.signalClass === c && a !== undefined) out[rule.signal] = a;
  }
  return out;
}

/** Counts only, so its size is fixed (§3.2). Null when nothing happened this period. */
export function digestFrom(
  store: LedgerStore,
  period: { readonly startMs: number; readonly endMs: number },
  site: SiteSummary | null,
  undeliverable: number,
  noticesDropped: SecurityDigest["noticesDropped"],
): SecurityDigest | null {
  const day = utcDay(period.endMs);
  const classes: DigestClassLine[] = ALL_CLASSES.map((c) => {
    const p = store.period(c);
    return {
      signalClass: c,
      sent: p.sent,
      suppressedByCooldown: p.by_cooldown,
      suppressedByBudget: p.by_budget,
      heldOpen: HELD_CLASSES.includes(c) ? openCount(store, c) : 0,
      heldCountedNotStored: countedToday(store, c, day),
      activity: activityFor(c, site),
    };
  });
  const overflowEvents = site?.overflowEvents ?? 0;
  const anything =
    undeliverable > 0 ||
    noticesDropped.dropped_permanent_refusal + noticesDropped.dropped_expired > 0 ||
    overflowEvents > 0 ||
    site === null ||
    classes.some(
      (l) =>
        l.sent + l.suppressedByCooldown + l.suppressedByBudget + l.heldOpen + l.heldCountedNotStored > 0 ||
        Object.values(l.activity).some((a) => a.events > 0),
    );
  if (!anything) return null;
  return {
    type: "digest",
    periodStart: new Date(period.startMs).toISOString(),
    periodEnd: new Date(period.endMs).toISOString(),
    classes,
    undeliverable,
    overflowEvents,
    siteSummaryUnavailable: site === null,
    noticesDropped,
  };
}
```

Prune (P-4, hard-bounded by I-1):

```ts
/**
 * The ledger's prune step (security-alerting spec §2.6 step 7, F3): delete
 * aged-out covered `held` rows, expired cooldowns and refs, and old day rows, in
 * chunks of 1,000, until nothing is left or the run's budget is spent.
 *
 * ⚠️ PLAN RULING P-4: THE BUDGET IS COUNTED IN CHUNKS, NOT MILLISECONDS. The spec
 * says "2 s", but workerd's clock does not advance during synchronous SQL (it
 * moves only on I/O; apps/api/test/helpers/limiter-window.ts's header), so a
 * `Date.now()` budget inside one transaction would never expire.
 * `PRUNE_CHUNKS_PER_RUN` chunks bound the work per alarm the same way; the caller
 * re-arms for NOW when work remains.
 */
import { deleteHeld, HELD_CLASSES } from "./ledger-held";
import { REF_TTL_MS, utcDay, type LedgerStore } from "./ledger-store";

export const PRUNE_CHUNK = 1_000;
export const PRUNE_CHUNKS_PER_RUN = 5;
/** A covered held row stays on the admin page this long after its last update (§2.6). */
export const COVERED_TTL_MS = 7 * 86_400_000;

/** One chunk of one prune target; returns how many rows it deleted. */
type PruneTarget = () => number;

function sqlTarget(store: LedgerStore, sql: string, ...bindings: (string | number)[]): PruneTarget {
  return () => store.sql.exec(sql, ...bindings).toArray().length;
}

function targets(store: LedgerStore, nowMs: number): PruneTarget[] {
  const yesterday = utcDay(nowMs - 86_400_000);
  const held = HELD_CLASSES.map(
    (c): PruneTarget =>
      () =>
        deleteHeld(
          store,
          `(signal_class, subject_key) IN (
             SELECT signal_class, subject_key FROM held
             WHERE signal_class = ? AND version <= ? AND updated_ms < ? LIMIT ${PRUNE_CHUNK})`,
          c,
          store.watermark(c),
          nowMs - COVERED_TTL_MS,
        ),
  );
  return [
    ...held,
    sqlTarget(
      store,
      `DELETE FROM cooldowns WHERE (signal, subject) IN (
         SELECT signal, subject FROM cooldowns WHERE until_ms <= ? LIMIT ${PRUNE_CHUNK}) RETURNING 1`,
      nowMs,
    ),
    sqlTarget(
      store,
      `DELETE FROM account_refs WHERE user_id IN (
         SELECT user_id FROM account_refs WHERE last_used_ms < ? LIMIT ${PRUNE_CHUNK}) RETURNING 1`,
      nowMs - REF_TTL_MS,
    ),
    sqlTarget(
      store,
      `DELETE FROM forgotten WHERE user_id IN (
         SELECT user_id FROM forgotten WHERE until_ms <= ? LIMIT ${PRUNE_CHUNK}) RETURNING 1`,
      nowMs,
    ),
    sqlTarget(store, "DELETE FROM meta WHERE k LIKE 'notice_dropped:%' AND substr(k, -10) < ? RETURNING 1", yesterday),
    sqlTarget(store, "DELETE FROM class_day WHERE day < ? RETURNING 1", yesterday),
    sqlTarget(store, "DELETE FROM held_overflow WHERE day < ? RETURNING 1", yesterday),
  ];
}

/**
 * Returns true when work may remain (the caller re-arms for NOW).
 *
 * ⚠️ HARD BOUND (audit I-1): the budget is checked BEFORE EVERY chunk, with
 * `<= 0`, so one call runs at most PRUNE_CHUNKS_PER_RUN chunks that delete
 * anything, whatever the targets' sizes or the order their chunks come back
 * short in. A chunk that deletes nothing costs no budget; a target is done when
 * a chunk comes back short.
 */
export function pruneLedger(store: LedgerStore, nowMs: number): boolean {
  let budget = PRUNE_CHUNKS_PER_RUN;
  for (const chunk of targets(store, nowMs)) {
    for (;;) {
      if (budget <= 0) return true;
      const deleted = chunk();
      if (deleted > 0) budget -= 1;
      if (deleted < PRUNE_CHUNK) break;
    }
  }
  return false;
}
```

The class (PR 1):

```ts
/**
 * `SecurityLedgerDO` — decides (security-alerting spec §2.6). One instance,
 * `ledger`. It receives only threshold crossings, never raw events, so a flood
 * cannot reach it at volume. It owns every cooldown, budget, held subject,
 * report and outbox row, mints the account refs, and is THE ONLY CALLER OF A
 * SINK (§3.3).
 *
 * ⚠️ THE DESIGN RULE (PM): no attacker-reachable signal may silence a
 * different signal class. Budgets are per class (`decide`, packages/shared).
 *
 * ⚠️ `alarm()` RUNS INDEPENDENT STEPS. Each is its own try/catch and, where it
 * writes, its own transaction; a failure logs `security: alerting_fault` with the
 * step as its reason and the next step still runs (R1). The ledger never calls
 * `deleteAll()`.
 */
import { DurableObject } from "cloudflare:workers";

import {
  CLASS_POLICY,
  decide,
  deliverSecurityAlert,
  HELD_ROW_CAP,
  LogSecurityAlertSink,
  logSecurityEvent,
  selectSecurityAlertSink,
  type CounterReport,
  type LedgerReportBatch,
  type SecurityAlertEnv,
  type SecurityAlertMessage,
  type SecurityAlertSink,
  type SecurityNoticeDropped,
  type SignalClass,
  type SiteSummary,
  type SiteSummaryRpc,
} from "@thinkersjournal/shared";

import { COUNTER_RETENTION_MINUTES } from "./SecurityCounterDO";
import { alertFrom, digestFrom, heartbeatFrom, HEARTBEAT_HOUR_UTC } from "../security/ledger-messages";
import {
  applyCoverage,
  buildHeldReport,
  countedToday,
  countOverflow,
  deleteHeld,
  renderSubject,
  upsertHeld,
  type HeldCovers,
} from "../security/ledger-held";
import { pruneLedger } from "../security/ledger-prune";
import { LEDGER_SCHEMA } from "../security/ledger-schema";
import { LedgerStore, utcDay, type ClassDay } from "../security/ledger-store";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** An anonymised account's tombstone outlasts any plausible ledger outage (§2.6 m-e). */
export const TOMBSTONE_MS = 30 * 86_400_000;
const DROP_STATES: readonly SecurityNoticeDropped["endState"][] = ["dropped_permanent_refusal", "dropped_expired"];
/** KV key in the HEALTH namespace: "the ledger's alarm runs" (§2.6 step 1, R2). */
export const LIVENESS_KEY = "security-ledger:ok";
/** Outbox rows delivered per alarm (§2.6 step 2). */
export const DELIVER_PER_RUN = 20;
/** Backoff after the 1st, 2nd and 3rd failed delivery; the 4th failure drops the row (§2.6 step 2). */
export const OUTBOX_BACKOFF_MINUTES: readonly number[] = [1, 5, 30];
/**
 * `adminUrl` in every held-subject report (§2.6). Null until the admin page
 * ships in PR 3, so no message links to a 404 (PM ruling I-11).
 */
export const SECURITY_ADMIN_URL: string | null = null;

type OutboxRow = { id: number; message: string; covers: string | null; attempts: number };

export class SecurityLedgerDO extends DurableObject<Env> {
  /** TEST SEAM (§3.3): which sink delivers. Board 131 changes `null` to its factory, here only. */
  sinkFactory: (env: SecurityAlertEnv) => SecurityAlertSink = (env) => selectSecurityAlertSink(env, null);
  /** TEST SEAM: the `site` counter, read for the digest's summary-class activity. */
  siteFor: () => SiteSummaryRpc = () => this.env.SECURITY_COUNTER.getByName("site");
  /**
   * TEST SEAM: where the next alarm goes. Tests record it, so a REAL alarm never
   * races their explicit clock (`alarmAt(nowMs)`); one test keeps it real to pin
   * the cron's `ensureLedgerAlarm`.
   */
  armAt: (ms: number) => Promise<void> = (ms) => this.ctx.storage.setAlarm(ms);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      for (const ddl of LEDGER_SCHEMA) this.ctx.storage.sql.exec(ddl);
    });
  }

  private get store(): LedgerStore {
    return new LedgerStore(this.ctx.storage.sql);
  }

  /** RPC from a counter's alarm (§2.4): a batch of crossings. */
  async report(batch: LedgerReportBatch): Promise<void> {
    await this.reportAt(batch, Date.now());
  }

  async reportAt(batch: LedgerReportBatch, nowMs: number): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const r of batch.reports) this.processReport(r, nowMs);
      for (const [signalClass, n] of Object.entries(batch.countedOverflow)) {
        if (n !== undefined && n > 0) this.countNotStored(signalClass as SignalClass, nowMs, n);
      }
    });
    // ALWAYS, even for an empty batch: a dead alarm must not survive a report (N2).
    await this.ensureAlarm();
  }

  /** RPC from the two-minute cron (m-d): set an alarm for now if none is set. Idempotent. */
  async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.armAt(Date.now());
  }

  private processReport(r: CounterReport, nowMs: number): void {
    const store = this.store;
    if (r.subjectKind === "account" && this.isForgotten(r.subject, nowMs)) return;
    const day = utcDay(nowMs);
    const cd = store.classDay(r.signalClass, day);
    const action = decide(r.signalClass, {
      nowMs,
      cooldownUntilMs: store.cooldownUntil(r.signal, r.subject),
      onsetSentToday: cd.onsetSignals.includes(r.signal),
      classSentToday: cd.sent,
      exhaustedQueuedToday: cd.exhaustedQueued,
    });
    switch (action.action) {
      case "send":
        this.send(r, action.cooldownUntilMs, cd, nowMs);
        return;
      case "summarise":
        // Summary-class activity reaches the digest from `site.summarise`, not from here.
        return;
      case "suppress_cooldown":
        store.addPeriod(r.signalClass, "by_cooldown");
        this.hold(r, nowMs);
        return;
      case "suppress_budget":
        this.refuseOnBudget(r, cd, action.queueExhausted, nowMs);
        return;
    }
  }

  private send(r: CounterReport, cooldownUntilMs: number | null, cd: ClassDay, nowMs: number): void {
    const store = this.store;
    const subject = renderSubject(store, r.subjectKind, r.subject, nowMs);
    store.queue(alertFrom(r, subject, this.env.CF_VERSION_METADATA?.id ?? null), nowMs);
    // The cooldown starts when the alert is QUEUED (§2.6).
    if (cooldownUntilMs !== null) store.setCooldown(r.signal, r.subject, cooldownUntilMs);
    const summary = CLASS_POLICY[r.signalClass].mode === "summary";
    const onsetSignals = summary ? [...cd.onsetSignals, r.signal] : cd.onsetSignals;
    store.saveClassDay(r.signalClass, utcDay(nowMs), { ...cd, sent: cd.sent + 1, onsetSignals });
    store.addPeriod(r.signalClass, "sent");
  }

  private refuseOnBudget(r: CounterReport, cd: ClassDay, queueExhausted: boolean, nowMs: number): void {
    const store = this.store;
    const day = utcDay(nowMs);
    const suppressed = cd.suppressed + 1;
    store.saveClassDay(r.signalClass, day, { ...cd, suppressed, exhaustedQueued: cd.exhaustedQueued || queueExhausted });
    store.addPeriod(r.signalClass, "by_budget");
    if (queueExhausted) {
      // Exempt from every budget: exhaustion is never silent (§2.6).
      store.queue(
        {
          type: "budget_exhausted",
          signalClass: r.signalClass,
          day,
          budget: CLASS_POLICY[r.signalClass].dailyBudget,
          suppressedSoFar: suppressed,
        },
        nowMs,
      );
    }
    this.hold(r, nowMs);
  }

  private hold(r: CounterReport, nowMs: number): void {
    if (upsertHeld(this.store, r, nowMs)) this.queueHeldCapped(r.signalClass, nowMs);
  }

  private countNotStored(signalClass: SignalClass, nowMs: number, n: number): void {
    if (countOverflow(this.store, signalClass, nowMs, n)) this.queueHeldCapped(signalClass, nowMs);
  }

  private queueHeldCapped(signalClass: SignalClass, nowMs: number): void {
    const day = utcDay(nowMs);
    this.store.queue(
      {
        type: "held_capped",
        signalClass,
        day,
        cap: HELD_ROW_CAP[signalClass],
        countedNotStored: countedToday(this.store, signalClass, day),
      },
      nowMs,
    );
  }

  async alarm(): Promise<void> {
    await this.alarmAt(Date.now());
  }

  /** §2.6's seven independent steps, then re-arm. */
  async alarmAt(nowMs: number): Promise<void> {
    await this.step("liveness", () => this.env.HEALTH.put(LIVENESS_KEY, String(nowMs)));
    await this.step("deliver", () => this.deliver(nowMs));
    await this.step("heartbeat", () => this.heartbeat(nowMs));
    await this.step("held_report", () => this.heldReport(nowMs));
    await this.step("digest", () => this.digest(nowMs));
    await this.step("config", () => this.configFault(nowMs));
    let pruneRemaining = false;
    await this.step("prune", () => {
      pruneRemaining = this.ctx.storage.transactionSync(() => pruneLedger(this.store, nowMs));
    });
    await this.rearm(nowMs, pruneRemaining);
  }

  private async step(reason: string, run: () => Promise<void> | void): Promise<void> {
    try {
      await run();
    } catch {
      logSecurityEvent({ kind: "alerting_fault", route: "security-ledger", reason, ip: null });
    }
  }

  /** Step 2: up to 20 due rows through `deliverSecurityAlert`; backoff 1, 5, 30 min; the 4th failure drops. */
  private async deliver(nowMs: number): Promise<void> {
    const sink = this.sinkFactory(this.env);
    const due = this.ctx.storage.sql
      .exec<OutboxRow>(
        "SELECT id, message, covers, attempts FROM outbox WHERE next_ms <= ? ORDER BY next_ms, id LIMIT ?",
        nowMs,
        DELIVER_PER_RUN,
      )
      .toArray();
    for (const row of due) {
      const message = JSON.parse(row.message) as SecurityAlertMessage;
      const result = await deliverSecurityAlert(sink, message);
      if (result.delivered) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("DELETE FROM outbox WHERE id = ?", row.id);
          if (row.covers !== null) applyCoverage(this.store, JSON.parse(row.covers) as HeldCovers);
        });
      } else {
        await this.deliveryFailed(row, message, nowMs);
      }
    }
  }

  private async deliveryFailed(row: OutboxRow, message: SecurityAlertMessage, nowMs: number): Promise<void> {
    const attempts = row.attempts + 1;
    const backoff = OUTBOX_BACKOFF_MINUTES[attempts - 1];
    if (backoff !== undefined) {
      this.ctx.storage.sql.exec(
        "UPDATE outbox SET attempts = ?, next_ms = ? WHERE id = ?",
        attempts,
        nowMs + backoff * MINUTE_MS,
        row.id,
      );
      return;
    }
    // Dropped: the full message goes to the log first (bounded, PII-minimal, §3.2), and the digest counts it.
    await new LogSecurityAlertSink().send(message);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM outbox WHERE id = ?", row.id);
      this.store.addMeta("undeliverable", 1);
    });
  }

  /** Step 3: the first alarm at or after 09:00 UTC each day queues one heartbeat (N2, m-d). */
  private heartbeat(nowMs: number): void {
    const day = utcDay(nowMs);
    if (new Date(nowMs).getUTCHours() < HEARTBEAT_HOUR_UTC) return;
    this.ctx.storage.transactionSync(() => {
      if (this.store.meta("last_heartbeat_day") === day) return;
      this.store.queue(heartbeatFrom(this.store, nowMs), nowMs);
      this.store.setMeta("last_heartbeat_day", day);
    });
  }

  /** Step 4: once per hour while anything is open, built in one transaction at sequence S (R1). */
  private heldReport(nowMs: number): void {
    const hour = String(Math.floor(nowMs / HOUR_MS));
    this.ctx.storage.transactionSync(() => {
      const store = this.store;
      if (store.meta("last_held_hour") === hour) return;
      const startMs = Number(store.meta("last_held_ms") ?? String(nowMs - HOUR_MS));
      const built = buildHeldReport(store, { startMs, endMs: nowMs }, SECURITY_ADMIN_URL);
      if (built === null) return;
      store.queue(built.report, nowMs, JSON.stringify(built.covers));
      store.setMeta("last_held_hour", hour);
      store.setMeta("last_held_ms", String(nowMs));
    });
  }

  /** Step 5: hourly, counts only. `site.summarise` is an RPC, so it runs OUTSIDE the transaction. */
  private async digest(nowMs: number): Promise<void> {
    const hour = String(Math.floor(nowMs / HOUR_MS));
    if (this.store.meta("last_digest_hour") === hour) return;
    // Clamped to what the site counter still holds (audit M-5): the digest's
    // period says exactly what was counted, never more.
    const lastMs = Number(this.store.meta("last_digest_ms") ?? String(nowMs - HOUR_MS));
    const startMs = Math.max(lastMs, nowMs - (COUNTER_RETENTION_MINUTES - 1) * MINUTE_MS);
    let site: SiteSummary | null = null;
    try {
      site = await this.siteFor().summarise(Math.floor(startMs / MINUTE_MS), Math.floor(nowMs / MINUTE_MS));
    } catch {
      site = null; // the digest says `siteSummaryUnavailable`
    }
    this.ctx.storage.transactionSync(() => {
      const store = this.store;
      const dropped = {
        dropped_permanent_refusal: store.metaNumber("notices_dropped:dropped_permanent_refusal"),
        dropped_expired: store.metaNumber("notices_dropped:dropped_expired"),
      };
      const digest = digestFrom(store, { startMs, endMs: nowMs }, site, store.metaNumber("undeliverable"), dropped);
      if (digest !== null) store.queue(digest, nowMs);
      for (const state of DROP_STATES) store.setMeta(`notices_dropped:${state}`, "0");
      store.resetPeriod();
      store.setMeta("undeliverable", "0");
      store.setMeta("last_digest_hour", hour);
      store.setMeta("last_digest_ms", String(nowMs));
    });
  }

  /** Step 6 (PR 2 fills this in): one `config_fault` per UTC day while the device key is absent. */
  private configFault(_nowMs: number): void {}

  private isForgotten(userId: string, nowMs: number): boolean {
    return this.store.count("SELECT COUNT(*) AS n FROM forgotten WHERE user_id = ? AND until_ms > ?", userId, nowMs) > 0;
  }

  /**
   * RPC for the nightly sweep (R2-1): the next `limit` account ids the ledger
   * still holds by user id (held rows and refs), after a cursor kept in `meta`
   * that wraps to the start, so successive runs visit every id, bounded per run.
   */
  async accountIdsPage(limit: number): Promise<string[]> {
    return this.ctx.storage.transactionSync(() => {
      const store = this.store;
      const after = store.meta("sweep_after") ?? "";
      const ids = store.sql
        .exec<{ id: string }>(
          `SELECT id FROM (SELECT subject AS id FROM held WHERE subject_kind = 'account'
                           UNION SELECT user_id AS id FROM account_refs)
           WHERE id > ? ORDER BY id LIMIT ?`,
          after,
          limit,
        )
        .toArray()
        .map((r) => r.id);
      store.setMeta("sweep_after", ids.length < limit ? "" : (ids.at(-1) ?? ""));
      return ids;
    });
  }

  /** RPC from both reapers (§2.6 m-e, §4.5): forget the account, and leave a 30-day tombstone. Idempotent. */
  async forgetAccount(userId: string): Promise<void> {
    await this.forgetAccountAt(userId, Date.now());
  }

  async forgetAccountAt(userId: string, nowMs: number): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM account_refs WHERE user_id = ?", userId);
      deleteHeld(this.store, "subject_kind = 'account' AND subject = ?", userId);
      sql.exec("DELETE FROM cooldowns WHERE subject = ?", userId);
      sql.exec(
        `INSERT INTO forgotten (user_id, until_ms) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET until_ms = excluded.until_ms`,
        userId,
        nowMs + TOMBSTONE_MS,
      );
    });
  }

  /** Prune work left → now; otherwise the next due outbox row or the next hour, whichever is sooner. */
  private async rearm(nowMs: number, pruneRemaining: boolean): Promise<void> {
    if (pruneRemaining) {
      await this.armAt(nowMs);
      return;
    }
    const next = this.ctx.storage.sql
      .exec<{ next_ms: number | null }>("SELECT MIN(next_ms) AS next_ms FROM outbox")
      .one().next_ms;
    const nextHour = (Math.floor(nowMs / HOUR_MS) + 1) * HOUR_MS;
    await this.armAt(Math.min(next ?? nextHour, nextHour));
  }
}
```

- [ ] **Step 3: GREEN** once Task 11 exports the class: `…/api test -- test/security-ledger-do.test.ts`. Mutation controls (all executed): (a) in `applyCoverage`, drop `AND version <= ?` — the F2 test goes RED; (b) restore the old prune loop (`budget === 0` checked only after a full chunk) — the two-target test goes RED with one call deleting 10,500 rows; (c) call `this.deliver(nowMs)` without its `step()` wrapper — "the DELIVER step throwing" goes RED (the whole alarm rejects); (d) add a fourth backoff step — "refuses 4 times" goes RED; restore each.

### Task 10: The cron hook

**Files:** create `apps/api/src/security/ledger-cron.ts`. Tested in Task 9's file (the one real-alarm test, with a bounded poll; and "ensureAlarm leaves an alarm that is already set alone").

```ts
/**
 * The cron's one ledger call (security-alerting spec §2.6 m-d): if the ledger's
 * alarm stopped, the next two-minute tick sets one. Idempotent; never throws,
 * so it can ride `ctx.waitUntil` beside the tick's real work.
 */
export async function ensureLedgerAlarm(env: Pick<Env, "SECURITY_LEDGER">): Promise<void> {
  try {
    await env.SECURITY_LEDGER.getByName("ledger").ensureAlarm();
  } catch (err) {
    console.error("security-ledger: ensureAlarm failed", err instanceof Error ? err.name : "threw");
  }
}
```

### Task 11: `scope.ts`, the dispatcher pin, and login counting

**Files:** create `apps/api/src/security/scope.ts`, `apps/api/test/security-scope.test.ts`, `apps/api/test/security-counting-routes.test.ts`; modify `apps/api/src/index.ts`, `apps/api/src/routes/login.ts`, `apps/api/test/route-protection.test.ts`.

**Produces** (§2.2 item 3, verbatim): `SecurityScopeEnv`, `SecurityScopeOverrides`, `setSecurityScopeOverridesForTests(next | null)`, `withSecurityScope<T>(env, ctx, run): Promise<T>`. `node:async_hooks` type-checks in the api as it stands (`@types/node` is pulled in transitively; positive control: assigning an `AsyncLocalStorage` to `number` is TS2322).

- [ ] **Step 1: RED.** The scope test (its "confirmation 3" case leaves `stubFor` at its default and finds the row in the real counter instance) and the end-to-end counting test:

```ts
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  limiterIpKey,
  logSecurityEvent,
  SecurityEventBuffer,
  shardFor,
  type CounterBatch,
  type SecurityEvent,
} from "@thinkersjournal/shared";

import { setSecurityScopeOverridesForTests, withSecurityScope } from "../src/security/scope";

/**
 * `withSecurityScope` (security-alerting spec §2.2 item 3). It must
 * return EXACTLY what the handler returns, call it once, and never let counting
 * change a response, whatever counting does.
 */
afterEach(() => {
  setSecurityScopeOverridesForTests(null);
  vi.restoreAllMocks();
});

const FAIL: SecurityEvent = { kind: "auth_failure", route: "/auth/login", reason: "invalid_credentials", ip: "203.0.113.9" };
const now = () => Promise.resolve();
const never = () => new Promise<void>(() => undefined);

function recorder(reject = false) {
  const calls: { shard: string; batch: CounterBatch }[] = [];
  return {
    calls,
    stubFor: (shard: string) => ({
      record: async (batch: CounterBatch) => {
        calls.push({ shard, batch });
        if (reject) throw new Error("counter down");
      },
    }),
  };
}

class ThrowingBuffer extends SecurityEventBuffer {
  override add(): void {
    throw new Error("buffer broke");
  }
}

describe("withSecurityScope", () => {
  it("returns the handler's own Response object and calls it once", async () => {
    const response = new Response("handler body");
    const handler = vi.fn(async () => response);
    expect(await withSecurityScope(env, createExecutionContext(), handler)).toBe(response);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("an event logged inside the scope is flushed in a waitUntil, one record per shard", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = recorder();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(now), stubFor: r.stubFor });
    const ctx = createExecutionContext();
    await withSecurityScope(env, ctx, async () => {
      logSecurityEvent(FAIL, { email: "p@example.invalid" });
      return new Response(null, { status: 401 });
    });
    await waitOnExecutionContext(ctx);
    expect(r.calls.map((c) => c.shard).sort()).toEqual(expect.arrayContaining(["site"]));
    expect(r.calls.some((c) => c.shard.startsWith("ip:"))).toBe(true);
  });

  it.each([
    ["counting off", { SECURITY_COUNTING: "off" }, () => recorder()],
    ["a throwing buffer", {}, () => recorder()],
    ["a rejecting stub", {}, () => recorder(true)],
  ] as const)("with %s: the same response, called once, nothing thrown", async (name, envOver, make) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = make();
    const buffer = name === "a throwing buffer" ? new ThrowingBuffer(now) : new SecurityEventBuffer(now);
    setSecurityScopeOverridesForTests({ buffer, stubFor: r.stubFor });
    const response = new Response("x");
    const handler = vi.fn(async () => {
      logSecurityEvent(FAIL);
      return response;
    });
    const ctx = createExecutionContext();
    expect(await withSecurityScope({ ...env, ...envOver }, ctx, handler)).toBe(response);
    await waitOnExecutionContext(ctx);
    expect(handler).toHaveBeenCalledTimes(1);
    if (name === "counting off") expect(r.calls).toHaveLength(0);
  });

  it("confirmation 3: with the DEFAULT stubFor, a flush in a request's waitUntil reaches the REAL counter instance", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(now) }); // stubFor left at its default
    const ip = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:${Math.floor(Math.random() * 0xffff).toString(16)}::9`;
    const ctx = createExecutionContext();
    await withSecurityScope(env, ctx, async () => {
      logSecurityEvent({ ...FAIL, ip }, { email: "p@example.invalid" });
      return new Response(null, { status: 401 });
    });
    await waitOnExecutionContext(ctx);
    const subject = limiterIpKey(ip);
    const rows = await runInDurableObject(env.SECURITY_COUNTER.getByName(shardFor("ip", subject)), (_c, s) =>
      s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM buckets WHERE subject = ?", subject).one().n,
    );
    expect(rows).toBe(1);
  });

  it("outside any scope (the cron) an event is logged but never counted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = recorder();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(now), stubFor: r.stubFor });
    logSecurityEvent(FAIL);
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(r.calls).toHaveLength(0);
  });

  it("no DO call on the response path: with a sleep that never ends, the response resolves and nothing is recorded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = recorder();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(never), stubFor: r.stubFor });
    const res = await withSecurityScope(env, createExecutionContext(), async () => {
      logSecurityEvent(FAIL);
      return new Response(null, { status: 401 });
    });
    expect(res.status).toBe(401);
    expect(r.calls).toHaveLength(0);
  });
});
```

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecurityEventBuffer, shardFor, type CounterBatch } from "@thinkersjournal/shared";

import worker from "../src";
import { hashPassword } from "../src/auth/password";
import { withClient } from "../src/db/client";
import { setSecurityScopeOverridesForTests } from "../src/security/scope";

/**
 * Login is counted end to end (security-alerting spec §2.2 item 2, §5), through
 * the real router and `withSecurityScope`, with the buffer and
 * the counter stubs swapped through the scope's test seam.
 */
const ORIGIN = "https://community.thinkersjournal.com";
const PASSWORD = "correct-horse-battery-staple";
const created: string[] = [];

afterEach(async () => {
  setSecurityScopeOverridesForTests(null);
  vi.restoreAllMocks();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("DELETE FROM users WHERE email = ANY($1)", [created.splice(0)]));
  await waitOnExecutionContext(ctx);
});

async function newUser(): Promise<{ email: string; id: string }> {
  const email = `alert_${crypto.randomUUID()}@example.test`;
  created.push(email);
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, await hashPassword(PASSWORD)],
    );
    return rows[0]?.id ?? "";
  });
  await waitOnExecutionContext(ctx);
  return { email, id };
}

function recorder(reject = false) {
  const calls: { shard: string; batch: CounterBatch }[] = [];
  return {
    calls,
    stubFor: (shard: string) => ({
      record: async (batch: CounterBatch) => {
        calls.push({ shard, batch });
        if (reject) throw new Error("counter down");
      },
    }),
  };
}

async function login(email: string, password: string, e: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://api.test/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.77" },
      body: JSON.stringify({ email, password }),
    }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("login is counted", () => {
  it("a wrong password for a real account → one targeted_account event on that account's shard", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = recorder();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(() => Promise.resolve()), stubFor: r.stubFor });
    const { email, id } = await newUser();
    expect((await login(email, "wrong-password-0000")).status).toBe(401);
    const acct = r.calls.find((c) => c.shard === shardFor("account", id));
    expect(acct?.batch.rows.find((row) => row.signal === "targeted_account")).toMatchObject({ subject: id, n: 1 });
  });

  it("a nonexistent address → no account increment (control: the case above)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = recorder();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(() => Promise.resolve()), stubFor: r.stubFor });
    await login(`nobody_${crypto.randomUUID()}@example.test`, "wrong-password-0000");
    expect(r.calls.some((c) => c.shard.startsWith("acct:"))).toBe(false);
    expect(r.calls.some((c) => c.shard === "site")).toBe(true);
  });

  it("a rejecting counter changes nothing: byte-identical 401 body, and a correct password still gets 200 + Set-Cookie", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { email } = await newUser();
    const control = await (await login(email, "wrong-password-0000", { ...env, SECURITY_COUNTING: "off" })).text();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(() => Promise.resolve()), stubFor: recorder(true).stubFor });
    expect(await (await login(email, "wrong-password-0000")).text()).toBe(control);
    const ok = await login(email, PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().some((c) => c.startsWith("tj_session="))).toBe(true);
  });

  it("kill switch: SECURITY_COUNTING=off still logs the security: line and records nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = recorder();
    setSecurityScopeOverridesForTests({ buffer: new SecurityEventBuffer(() => Promise.resolve()), stubFor: r.stubFor });
    const { email } = await newUser();
    await login(email, "wrong-password-0000", { ...env, SECURITY_COUNTING: "off" });
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith("security: auth_failure /auth/login"))).toBe(true);
    expect(r.calls).toHaveLength(0);
  });
});
```

and update the pinned snapshot with exactly §2.2's four changes (the PR description shows this diff):

```diff
--- a/apps/api/test/route-protection.test.ts
+++ b/apps/api/test/route-protection.test.ts
@@ -174,14 +174,24 @@
   'import { runEmailDrain } from "./notifications/email-drain"; ' +
   'import { ROUTES } from "./routes"; ' +
   'import { findRoute } from "./routing"; ' +
+  // Security alerting (spec §2.2 item 3): the cron's one ledger call, and the
+  // request-scope wrapper whose import installs the counting observer. Neither
+  // dispatches anything.
+  'import { sweepForgottenAccounts } from "./security/forget-sweep"; ' +
+  'import { ensureLedgerAlarm } from "./security/ledger-cron"; ' +
+  'import { withSecurityScope } from "./security/scope"; ' +
   'export { UserSecurityDO } from "./durable-objects/UserSecurityDO"; ' +
   'export { NotifyDO } from "./durable-objects/NotifyDO"; ' +
   'export { PostLiveDO } from "./durable-objects/PostLiveDO"; ' +
+  'export { SecurityCounterDO } from "./durable-objects/SecurityCounterDO"; ' +
+  'export { SecurityLedgerDO } from "./durable-objects/SecurityLedgerDO"; ' +
   "export default { async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { " +
   "const { pathname } = new URL(request.url); " +
   "const match = findRoute(ROUTES, request.method, pathname); " +
   "if (match === null) return notFoundResponse(); " +
-  "return await match.route.handler(request, env, ctx, match.params); " +
+  // The same handler, called once, for the same matched route — wrapped so
+  // counting can see its security events (spec §2.2; test/security-scope.test.ts).
+  "return await withSecurityScope(env, ctx, () => match.route.handler(request, env, ctx, match.params)); " +
   "}, " +
   // The scheduled() cron dispatcher (M2.3c + handle-at-signup Task 8 +
   // content-deletion/media-reclamation Task 4 + db-health-probe) — a THIN
@@ -193,6 +203,8 @@
   'if (controller.cron === "30 3 * * *") { ' +
   "ctx.waitUntil(reapUnverifiedAccounts(env, ctx)); " +
   "ctx.waitUntil(reapUnconfirmedDsaNotices(env, ctx)); " +
+  // Security alerting (PM ruling R2-1): the nightly N7 sweep rides the reaper's tick.
+  "ctx.waitUntil(sweepForgottenAccounts(env, ctx)); " +
   "return; " +
   "} " +
   'if (controller.cron === "15 4 * * *") { ' +
@@ -209,6 +221,7 @@
   "} " +
   'if (controller.cron === "*/2 * * * *") { ' +
   "ctx.waitUntil(runMediaBackfillBatch(env, ctx)); " +
+  "ctx.waitUntil(ensureLedgerAlarm(env)); " +
   "} " +
   'const disposition = controller.cron === "0 14 * * *" ? "digest" : "instant"; ' +
   "ctx.waitUntil(runEmailDrain(env, ctx, disposition)); " +
```

- [ ] **Step 2: Implement.** `scope.ts` is the spec's §2.2 item 3 block verbatim.

The file is the spec block exactly (checked byte for byte, LF, when this plan was generated).

`index.ts` changes in exactly those four ways:

```diff
--- a/apps/api/src/index.ts
+++ b/apps/api/src/index.ts
@@ -9,10 +9,15 @@
 import { runEmailDrain } from "./notifications/email-drain";
 import { ROUTES } from "./routes";
 import { findRoute } from "./routing";
+import { sweepForgottenAccounts } from "./security/forget-sweep";
+import { ensureLedgerAlarm } from "./security/ledger-cron";
+import { withSecurityScope } from "./security/scope";
 
 export { UserSecurityDO } from "./durable-objects/UserSecurityDO";
 export { NotifyDO } from "./durable-objects/NotifyDO";
 export { PostLiveDO } from "./durable-objects/PostLiveDO";
+export { SecurityCounterDO } from "./durable-objects/SecurityCounterDO";
+export { SecurityLedgerDO } from "./durable-objects/SecurityLedgerDO";
 
 /**
  * ⚠️ THIS FILE ONLY DISPATCHES. Do not add an `if` here: every route belongs in
@@ -25,7 +30,7 @@
     const { pathname } = new URL(request.url);
     const match = findRoute(ROUTES, request.method, pathname);
     if (match === null) return notFoundResponse();
-    return await match.route.handler(request, env, ctx, match.params);
+    return await withSecurityScope(env, ctx, () => match.route.handler(request, env, ctx, match.params));
   },
   /*
    * Six cron patterns, one dispatcher. `30 3 * * *` is the unverified-account
@@ -65,6 +70,7 @@
          same daily tick as the account reaper (see src/moderation/dsa-notices.ts). */
       ctx.waitUntil(reapUnverifiedAccounts(env, ctx));
       ctx.waitUntil(reapUnconfirmedDsaNotices(env, ctx));
+      ctx.waitUntil(sweepForgottenAccounts(env, ctx));
       return;
     }
     if (controller.cron === "15 4 * * *") {
@@ -89,6 +95,7 @@
      */
     if (controller.cron === "*/2 * * * *") {
       ctx.waitUntil(runMediaBackfillBatch(env, ctx));
+      ctx.waitUntil(ensureLedgerAlarm(env));
     }
     const disposition = controller.cron === "0 14 * * *" ? "digest" : "instant";
     ctx.waitUntil(runEmailDrain(env, ctx, disposition));
```

Login passes the counting argument (§2.2 item 2), and the comment at `:163` stops saying the follow-up "counts by IP and route":

```diff
--- a/apps/api/src/routes/login.ts
+++ b/apps/api/src/routes/login.ts
@@ -84,7 +84,7 @@
  *       same Argon2id cost before returning the same 401. See `DUMMY_HASH`'s
  *       own comment for how that constant was produced.
  */
-import { LoginInput, limiterIpKey, logSecurityEvent } from "@thinkersjournal/shared";
+import { LoginInput, limiterIpKey, logSecurityEvent, type SecurityEventCounting } from "@thinkersjournal/shared";
 
 import { accountBarredResponse, isBarred, loadBarReason } from "../auth/account-status";
 import { checkOrigin } from "../auth/csrf";
@@ -162,8 +162,8 @@
  * the enumeration oracle the response refuses to be. Never the password, and
  * never the email: the alerting follow-up counts by IP and route.
  */
-function unauthorized(ip: string | null): Response {
-  logSecurityEvent({ kind: "auth_failure", route: ROUTE, reason: "invalid_credentials", ip });
+function unauthorized(ip: string | null, counting: SecurityEventCounting): Response {
+  logSecurityEvent({ kind: "auth_failure", route: ROUTE, reason: "invalid_credentials", ip }, counting);
   return errorResponse("INVALID_CREDENTIALS", 401);
 }
 
@@ -319,12 +319,12 @@
     // costs about the same as a wrong-password rejection below. The result is
     // never used for anything — see `DUMMY_HASH`'s comment.
     await verifyPassword(password, DUMMY_HASH);
-    return unauthorized(ip);
+    return unauthorized(ip, { email });
   }
 
   const passwordOk = await verifyPassword(password, row.password_hash);
   if (!passwordOk) {
-    return unauthorized(ip);
+    return unauthorized(ip, { email, userId: row.id });
   }
 
   // ---- 6. Barring refusal (issue #35) ----------------------------------------
```

- [ ] **Step 3: GREEN.** `…/api test -- test/security-scope.test.ts test/security-counting-routes.test.ts test/route-protection.test.ts test/login.test.ts test/reset-password.test.ts`, then `pnpm --filter @thinkersjournal/api typecheck`. Mutation control: replace `return scopeStore.run(scope, run);` with `return run();` — the counting tests go RED; restore.

### Task 12: The web purge binding

**Files:** create `apps/web/src/lib/security-counting.ts`, `apps/web/test/security-counting.test.ts`; modify `apps/web/src/lib/purge.ts`, `apps/web/src/pages/internal/purge.ts`, `apps/web/test/purge.test.ts`.

**Produces:** `type PurgeSecurityEventSink = (event: SecurityEvent, at: Date) => void`; `handlePurgeRequest(context, secret, failureLimiter, onSecurityEvent)` (§2.2 item 4); `purgeSecurityEventSink(env, waitUntil, target?)`. The page takes `waitUntil` from `cloudflare:workers` (exported there, `apps/web/worker-configuration.d.ts`), beside the `env` it already imports.

- [ ] **Step 1: RED.**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecurityEventBuffer, type CounterBatch, type SecurityCounterRpc } from "@thinkersjournal/shared";

import { handlePurgeRequest } from "../src/lib/purge";
import { purgeSecurityEventSink } from "../src/lib/security-counting";

import type { PurgeContext, PurgeFailureLimiter } from "../src/lib/purge";

/**
 * The web Worker's purge counting (security-alerting spec §2.2 item 4; plan
 * Task 12). Plain Node, like test/purge.test.ts: the DO binding is a fake.
 */
afterEach(() => vi.restoreAllMocks());

const SECRET = "dev-purge-secret-not-for-production";

function ctxWith(secret: string, ip = "203.0.113.9"): PurgeContext {
  return {
    request: new Request("https://community.thinkersjournal.com/internal/purge", {
      method: "POST",
      headers: { "X-Purge-Secret": secret, "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ tags: ["post:1"] }),
    }),
    cache: { invalidate: vi.fn(async () => undefined) },
  };
}

const allow: PurgeFailureLimiter = { limit: async () => ({ success: true }) };

function fakeEnv(counting = "on") {
  const calls: { shard: string; batch: CounterBatch }[] = [];
  const stub = (shard: string): SecurityCounterRpc => ({
    record: async (batch) => {
      calls.push({ shard, batch });
    },
  });
  return { calls, env: { SECURITY_COUNTING: counting, SECURITY_COUNTER: { getByName: stub } } };
}

describe("purge counting", () => {
  it("a wrong secret calls onSecurityEvent once; a right one never (positive control first)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen = vi.fn();
    expect((await handlePurgeRequest(ctxWith(SECRET), SECRET, allow, seen)).status).toBe(200);
    expect(seen).not.toHaveBeenCalled();
    expect((await handlePurgeRequest(ctxWith("wrong-secret-of-the-same-length-000000"), SECRET, allow, seen)).status).toBe(403);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]?.[0]).toMatchObject({ kind: "auth_failure", route: "/internal/purge", reason: "bad_purge_secret" });
  });

  it("a flood of 50 wrong secrets → ONE record per flush, to `site`, not 50", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { calls, env } = fakeEnv();
    const pending: Promise<unknown>[] = [];
    let release: () => void = () => undefined;
    const buffer = new SecurityEventBuffer(() => new Promise<void>((r) => (release = r)));
    const sink = purgeSecurityEventSink(env, (p) => pending.push(p), buffer);
    for (let i = 0; i < 50; i++) await handlePurgeRequest(ctxWith(`wrong-${i}`), SECRET, allow, sink);
    expect(calls).toHaveLength(0);
    release();
    await Promise.all(pending);
    expect(calls.map((c) => c.shard)).toEqual(["site"]);
    expect(calls[0]?.batch.rows.find((r) => r.signal === "purge_secret_failure")?.n).toBe(50);
  });

  it('SECURITY_COUNTING="off" → a no-op: no waitUntil, no record', async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { calls, env } = fakeEnv("off");
    const waitUntil = vi.fn();
    const sink = purgeSecurityEventSink(env, waitUntil, new SecurityEventBuffer(() => Promise.resolve()));
    await handlePurgeRequest(ctxWith("wrong"), SECRET, allow, sink);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("a throwing onSecurityEvent never turns the 403 into a 500", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const boom = () => {
      throw new Error("counting broke");
    };
    expect((await handlePurgeRequest(ctxWith("wrong"), SECRET, allow, boom)).status).toBe(403);
  });
});
```

In `test/purge.test.ts`, the type import gains `PurgeSecurityEventSink` and one constant follows it; then every one of the 26 `handlePurgeRequest(…)` calls gains `noCount` as its fourth argument (`tsc` lists each as TS2554 until it does; nothing else in the file changes):

```diff
-import type { PurgeContext, PurgeFailureLimiter } from "../src/lib/purge";
+import type { PurgeContext, PurgeFailureLimiter, PurgeSecurityEventSink } from "../src/lib/purge";
+
+/** The fourth argument for every case that is not about counting. */
+const noCount: PurgeSecurityEventSink = () => undefined;
```

- [ ] **Step 2: Implement.**

```ts
/**
 * The web Worker's half of security counting (security-alerting spec §2.2 item
 * 4). The purge route is the web Worker's only `security:` source; its failures
 * go into ONE module-scoped `SecurityEventBuffer` per isolate (the same class the
 * api uses, packages/shared), flushed to the api's `site` counter through a
 * cross-script Durable Object binding.
 *
 * ⚠️ PURGE_LIMITER DOES NOT CAP FAILURES (apps/web/wrangler.jsonc): every wrong
 * secret is an event. The buffer is what bounds the cost: at most one `record`
 * RPC per isolate per `FLUSH_DELAY_MS`, however many failures arrive.
 */
import { SecurityEventBuffer, type SecurityCounterRpc, type SecurityEvent } from "@thinkersjournal/shared";

/** The env keys this module reads. The web `Env` satisfies it. */
export interface SecurityCountingEnv {
  /** `"off"` is the kill switch (spec §3.1). */
  readonly SECURITY_COUNTING?: string;
  readonly SECURITY_COUNTER: { getByName(name: string): SecurityCounterRpc };
}

const isolateBuffer = new SecurityEventBuffer();

/**
 * The purge page's `onSecurityEvent`. `target` is a TEST SEAM (a buffer with an
 * injected `sleep`); production uses the isolate's buffer.
 */
export function purgeSecurityEventSink(
  env: SecurityCountingEnv,
  waitUntil: (promise: Promise<unknown>) => void,
  target: SecurityEventBuffer = isolateBuffer,
): (event: SecurityEvent, at: Date) => void {
  if (env.SECURITY_COUNTING === "off") return () => undefined;
  const scope = { waitUntil, stubFor: (shard: string) => env.SECURITY_COUNTER.getByName(shard) };
  return (event, at) => target.add(event, at, {}, scope);
}
```

```diff
--- a/apps/web/src/lib/purge.ts
+++ b/apps/web/src/lib/purge.ts
@@ -30,7 +30,7 @@
  * instead of provable only by deploying. Same shape as src/lib/cache.ts: the
  * decisions live in a module with a structural context; the page is glue.
  */
-import { limiterIpKey, logSecurityEvent, timingSafeEqual } from "@thinkersjournal/shared";
+import { limiterIpKey, logSecurityEvent, timingSafeEqual, type SecurityEvent } from "@thinkersjournal/shared";
 
 /**
  * The subset of Astro's `APIContext` this needs. Structural rather than importing
@@ -86,6 +86,24 @@
  */
 export interface PurgeFailureLimiter {
   limit: (options: { key: string }) => Promise<{ success: boolean }>;
+}
+
+/**
+ * Where a purge failure is COUNTED (security-alerting spec §2.2 item 4). The web
+ * Worker installs no observer: this route is its one source, so it hands each
+ * event over explicitly. The page passes a module-scoped `SecurityEventBuffer`
+ * (src/lib/security-counting.ts), or a no-op when `SECURITY_COUNTING` is "off".
+ */
+export type PurgeSecurityEventSink = (event: SecurityEvent, at: Date) => void;
+
+/** Log the `security:` line, then count it. Counting can never fail the refusal. */
+function logAndCount(event: SecurityEvent, onSecurityEvent: PurgeSecurityEventSink): void {
+  logSecurityEvent(event);
+  try {
+    onSecurityEvent(event, new Date());
+  } catch {
+    // A counting failure must never turn a 403 into a 500.
+  }
 }
 
 /** This route, as its `security:` log lines name it. */
@@ -127,15 +145,16 @@
   context: PurgeContext,
   secret: string | undefined,
   failureLimiter: PurgeFailureLimiter,
+  onSecurityEvent: PurgeSecurityEventSink,
 ): Promise<Response> {
   if (!(await authorized(context.request.headers.get(SECRET_HEADER), secret))) {
     const ip = context.request.headers.get("CF-Connecting-IP");
     // The submitted value is NEVER logged — only that it failed, and from where.
-    logSecurityEvent({ kind: "auth_failure", route: ROUTE, reason: "bad_purge_secret", ip });
+    logAndCount({ kind: "auth_failure", route: ROUTE, reason: "bad_purge_secret", ip }, onSecurityEvent);
     if (ip !== null) {
       const { success } = await failureLimiter.limit({ key: `purge-fail:${limiterIpKey(ip)}` });
       if (!success) {
-        logSecurityEvent({ kind: "rate_limited", route: ROUTE, reason: "ip", ip });
+        logAndCount({ kind: "rate_limited", route: ROUTE, reason: "ip", ip }, onSecurityEvent);
         return json({ code: "RATE_LIMITED" }, 429);
       }
     }
```

```diff
--- a/apps/web/src/pages/internal/purge.ts
+++ b/apps/web/src/pages/internal/purge.ts
@@ -36,10 +36,11 @@
  * binding and declares cacheability. The two things it does are the two things
  * that cannot be done there.
  */
-import { env } from "cloudflare:workers";
+import { env, waitUntil } from "cloudflare:workers";
 
 import { markPrivate } from "../../lib/cache";
 import { handlePurgeRequest } from "../../lib/purge";
+import { purgeSecurityEventSink } from "../../lib/security-counting";
 
 import type { APIRoute } from "astro";
 
@@ -51,7 +52,14 @@
   // reasoning (and the same trap) as src/lib/api.ts's header.
   // `PURGE_LIMITER` (wrangler.jsonc) is spent only by FAILED attempts — see
   // handlePurgeRequest's header for why the api's own purges never touch it.
-  const response = await handlePurgeRequest(context, env.PURGE_SECRET, env.PURGE_LIMITER);
+  // Counting (security-alerting spec §2.2 item 4): a module-scoped buffer, one
+  // `site` RPC per isolate per 5 s at most, flushed in THIS request's waitUntil.
+  const response = await handlePurgeRequest(
+    context,
+    env.PURGE_SECRET,
+    env.PURGE_LIMITER,
+    purgeSecurityEventSink(env, waitUntil),
+  );
 
   // ⚠️ THIS ROUTE DECLARES ITS CACHEABILITY LIKE EVERY OTHER PAGE, and is NOT
   // exempt from test/page-cache-inventory.test.ts. An earlier draft of the plan
```

- [ ] **Step 3: GREEN.** `pnpm --filter @thinkersjournal/web test -- test/purge.test.ts test/security-counting.test.ts` and `pnpm --filter @thinkersjournal/web typecheck`.

### Task 13: The reapers forget the account in the ledger, and the nightly sweep (N7; I-11, R2-1)

**Files:** create `apps/api/src/security/forget.ts` (PR 1 version), `apps/api/src/security/forget-sweep.ts`, `apps/api/test/security-forget-sweep.test.ts`; modify `apps/api/src/auth/anonymise-accounts.ts`, `apps/api/src/auth/reap-unverified.ts`, `apps/api/test/anonymise-accounts.test.ts`, `apps/api/test/reap-unverified.test.ts`. (The sweep's cron line is in Task 11's `index.ts` diff and snapshot.)

**Produces:** `forgetAccountEverywhere(env, userId, source)` — in PR 1, `ledger.forgetAccount(userId)` only, logged and continued on failure (§4.5, "with that block's failure handling"). The anonymise reaper collects each account it scrubbed (after its post-scrub bump, `anonymise-accounts.ts:158-163`); the unverified reaper's `DELETE` gains `RETURNING id`. Both then **await** `forgetAll` (every id, at most `FORGET_CONCURRENCY` = 50 in flight) after `withClient` returns, so every row lock is released first (revision 2's run showed per-row DO calls inside the loop pushing the existing RF6 and SKIP LOCKED lock tests past their 2–3 s windows) and the run cannot end before the forgets do (R2-1). `sweepForgottenAccounts(env, ctx, ledger?)` (P-17) re-forgets nightly whatever a failure left; its test loses a forget on purpose (a rejecting ledger call) and shows the sweep recovering both an anonymised and a deleted account while a live one keeps its rows. PR 2 adds the device steps (Task 21).

- [ ] **Step 1: RED.** The anonymise cases include the deterministic lock case (`whileReaperWaits`, `pg_blocking_pids`): a hold landing while the reaper waits means no scrub, so no forget.

```diff
--- a/apps/api/test/anonymise-accounts.test.ts
+++ b/apps/api/test/anonymise-accounts.test.ts
@@ -1,4 +1,4 @@
-import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
+import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
 import { afterEach, describe, expect, it } from "vitest";
 
 import worker from "../src";
@@ -843,3 +843,71 @@
     expect(await tokenCount(control.id)).toBe(2);
   });
 });
+
+/**
+ * Security alerting (spec §2.6 N7, m-e) — PR 1: the anonymise reaper forgets the
+ * account in the ledger (with a 30-day tombstone), beside its post-scrub bump.
+ */
+describe("anonymiseExpiredAccounts — ledger clean-up", () => {
+  const LEDGER = () => env.SECURITY_LEDGER.getByName("ledger");
+  const crossing = (subject: string) => ({
+    signal: "targeted_account" as const,
+    signalClass: "account" as const,
+    subjectKind: "account" as const,
+    subject,
+    windowStartMs: Date.now() - 3_600_000,
+    windowEndMs: Date.now(),
+    observed: 30,
+    events: 30,
+    threshold: 30,
+    severity: "critical" as const,
+    byRoute: { "/auth/login": 30 },
+  });
+
+  /** A sent alert (ref + cooldown), then a held row: three ledger rows that name the account. */
+  async function seedLedger(id: string): Promise<void> {
+    await LEDGER().report({ reports: [crossing(id), crossing(id)], countedOverflow: {} });
+  }
+
+  async function ledgerRows(id: string): Promise<number> {
+    return runInDurableObject(LEDGER(), (_l, s) =>
+      s.storage.sql
+        .exec<{ n: number }>(
+          `SELECT (SELECT COUNT(*) FROM account_refs WHERE user_id = ?1)
+                + (SELECT COUNT(*) FROM held WHERE subject_kind = 'account' AND subject = ?1)
+                + (SELECT COUNT(*) FROM cooldowns WHERE subject = ?1) AS n`,
+          id,
+        )
+        .one().n,
+    );
+  }
+
+  it("forgets the account's ledger rows (positive control: all three present before)", async () => {
+    const f = await seedAccount({ eligible: false });
+    await seedLedger(f.id);
+    expect(await ledgerRows(f.id)).toBe(3);
+    await withAnonymiseReaperLock(async () => {
+      await makeEligible(f.id);
+      const ctx = createExecutionContext();
+      await anonymiseExpiredAccounts(env, ctx);
+      await waitOnExecutionContext(ctx);
+    });
+    expect(await ledgerRows(f.id)).toBe(0);
+    expect(await env.USER_SECURITY.getByName(f.id).getEpoch()).toBe(2);
+  });
+
+  it("a report delivered after the forget re-creates nothing (the 30-day tombstone)", async () => {
+    const f = await seedAccount({ eligible: false });
+    await LEDGER().forgetAccount(f.id);
+    await seedLedger(f.id);
+    expect(await ledgerRows(f.id)).toBe(0);
+  });
+
+  it("a row the reaper does NOT scrub (a hold lands while it waits) keeps its ledger rows: the hook follows the scrub", async () => {
+    const f = await seedAccount({ eligible: false });
+    await seedLedger(f.id);
+    await whileReaperWaits(f.id, (locker) => imposeHold(locker, f.id, "dmca"));
+    expect(await anonymisedAt(f.id)).toBeNull();
+    expect(await ledgerRows(f.id)).toBe(3);
+  });
+});
```

```diff
--- a/apps/api/test/reap-unverified.test.ts
+++ b/apps/api/test/reap-unverified.test.ts
@@ -1,4 +1,4 @@
-import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
+import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
 import { afterEach, describe, expect, it } from "vitest";
 
 import worker from "../src";
@@ -324,3 +324,34 @@
     expect(await present(control.id), "the reaper deleted nothing").toBe(false);
   });
 });
+
+/** Security alerting (spec §2.6 N7) — PR 1: RETURNING id, then the ledger forgets each deleted account. */
+describe("reapUnverifiedAccounts — ledger clean-up per deleted id", () => {
+  it("a reaped account's ledger ref is gone (control: a verified account keeps its own)", async () => {
+    const gone = await seed({ verified: false, ageDays: 8 });
+    const kept = await seed({ verified: true, ageDays: 8 });
+    const ledger = env.SECURITY_LEDGER.getByName("ledger");
+    const now = Date.now();
+    for (const f of [gone, kept]) {
+      await ledger.report({
+        reports: [
+          {
+            signal: "targeted_account", signalClass: "account", subjectKind: "account", subject: f.id,
+            windowStartMs: now - 3_600_000, windowEndMs: now, observed: 30, events: 30, threshold: 30,
+            severity: "critical", byRoute: { "/auth/login": 30 },
+          },
+        ],
+        countedOverflow: {},
+      });
+    }
+    const ctx = createExecutionContext();
+    await reapUnverifiedAccounts(env, ctx);
+    await waitOnExecutionContext(ctx);
+    const refs = (id: string) =>
+      runInDurableObject(ledger, (_l, s) =>
+        s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM account_refs WHERE user_id = ?", id).one().n,
+      );
+    expect(await refs(gone.id)).toBe(0);
+    expect(await refs(kept.id)).toBe(1);
+  });
+});
```

- [ ] **Step 2: Implement.**

```ts
/**
 * The reapers' security clean-up for one account (security-alerting spec §2.6
 * N7, m-e): forget it in the ledger, leaving a 30-day tombstone. PR 2 adds the
 * device-list and pending-notice steps beside this one.
 *
 * Each call is logged and continued on failure — the same handling as the
 * anonymise reaper's post-scrub epoch bump. The backstop: the 7-day ref expiry.
 */
export async function forgetAccountEverywhere(
  env: Pick<Env, "SECURITY_LEDGER">,
  userId: string,
  source: string,
): Promise<void> {
  const steps: readonly (readonly [string, () => Promise<void>])[] = [
    ["forgetAccount", () => env.SECURITY_LEDGER.getByName("ledger").forgetAccount(userId)],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      console.error(`${source}: ${name} failed for ${userId}; the TTL backstop applies`, err);
    }
  }
}

/** At most this many accounts' clean-ups in flight at once (bounds concurrent RPCs per run). */
export const FORGET_CONCURRENCY = 50;

/**
 * Both reapers AWAIT this after their locks are released (PM ruling R2-1): every
 * id's clean-up, `FORGET_CONCURRENCY` at a time, so a run of 500 neither ends
 * before its forgets nor opens 1,500 RPCs at once. Never throws.
 */
export async function forgetAll(
  env: Parameters<typeof forgetAccountEverywhere>[0],
  ids: readonly string[],
  source: string,
): Promise<void> {
  for (let i = 0; i < ids.length; i += FORGET_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + FORGET_CONCURRENCY).map((id) => forgetAccountEverywhere(env, id, source)));
  }
}
```

```ts
/**
 * The nightly N7 sweep (security-alerting spec §2.6 N7, m-e; PM ruling R2-1).
 *
 * A reaper's forget can be lost: the Durable Object call fails (logged once),
 * or the invocation ends after the Postgres commit. Neither reaper selects that
 * account again: an anonymised row no longer matches its candidate query, and an
 * unverified one is deleted. So this sweep re-forgets, every night from the
 * existing `30 3 * * *` cron:
 *
 *   1. every account ANONYMISED in the last 3 days (refreshing its tombstone,
 *      so a report that waited out an outage cannot re-create its rows); and
 *   2. every account id the ledger still holds (held rows, refs) whose user is
 *      anonymised or DELETED — a deleted row leaves nothing to query, so the
 *      ledger's own ids are reconciled against Postgres instead.
 *
 * Idempotent (`forgetAccount` only deletes and refreshes a tombstone), bounded
 * per run (SWEEP_BATCH ids each; the ledger's page cursor wraps), never throws,
 * and logs each run's counts.
 */
import { withClient } from "../db/client";

export const SWEEP_BATCH = 200;
export const SWEEP_RECENT_DAYS = 3;

/** The ledger slice the sweep uses. */
export interface ForgetSweepLedger {
  accountIdsPage(limit: number): Promise<string[]>;
  forgetAccount(userId: string): Promise<void>;
}

export interface SweepCounts {
  readonly recentAnonymised: number;
  readonly ledgerChecked: number;
  readonly ledgerForgotten: number;
  readonly failed: number;
}

/** Forgets in flight at once: bounds the run's concurrent RPCs (and its length). */
export const SWEEP_CONCURRENCY = 50;

async function forgetEach(ledger: ForgetSweepLedger, ids: readonly string[]): Promise<number> {
  let failed = 0;
  for (let i = 0; i < ids.length; i += SWEEP_CONCURRENCY) {
    const results = await Promise.allSettled(ids.slice(i, i + SWEEP_CONCURRENCY).map((id) => ledger.forgetAccount(id)));
    failed += results.filter((r) => r.status === "rejected").length;
  }
  return failed;
}

/** The given ids that still belong to a live (not anonymised, not deleted) account. */
async function liveIds(env: Pick<Env, "HYPERDRIVE_FRESH">, ctx: ExecutionContext, ids: readonly string[]) {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "SELECT id::text AS id FROM users WHERE id::text = ANY($1::text[]) AND anonymised_at IS NULL",
      [ids],
    );
    return new Set(rows.map((r) => r.id));
  });
}

export async function sweepForgottenAccounts(
  env: Pick<Env, "HYPERDRIVE_FRESH" | "SECURITY_LEDGER">,
  ctx: ExecutionContext,
  ledger: ForgetSweepLedger = env.SECURITY_LEDGER.getByName("ledger"),
): Promise<SweepCounts | null> {
  try {
    const recent = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id::text AS id FROM users WHERE anonymised_at > now() - make_interval(days => $1)
          ORDER BY anonymised_at DESC LIMIT $2`,
        [SWEEP_RECENT_DAYS, SWEEP_BATCH],
      );
      return rows.map((r) => r.id);
    });
    let failed = await forgetEach(ledger, recent);
    const page = await ledger.accountIdsPage(SWEEP_BATCH);
    const live = page.length === 0 ? new Set<string>() : await liveIds(env, ctx, page);
    const gone = page.filter((id) => !live.has(id));
    failed += await forgetEach(ledger, gone);
    const counts = { recentAnonymised: recent.length, ledgerChecked: page.length, ledgerForgotten: gone.length, failed };
    console.log("security-forget-sweep", counts);
    return counts;
  } catch (err) {
    console.error("security-forget-sweep: run failed", err instanceof Error ? err.name : "threw");
    return null;
  }
}
```

```ts
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withClient } from "../src/db/client";
import { forgetAccountEverywhere } from "../src/security/forget";
import { SWEEP_BATCH, sweepForgottenAccounts } from "../src/security/forget-sweep";

import { quiet } from "./helpers/security-do";

/**
 * The nightly N7 sweep (security-alerting spec §2.6 N7, m-e; PM ruling R2-1).
 * Each test uses a FRESH ledger instance, passed to the sweep, so the real
 * `ledger` and other files' rows never matter.
 */
const created: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [created.splice(0)]));
  await waitOnExecutionContext(ctx);
});

async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => (await c.query(text, params)).rows as T[]);
  await waitOnExecutionContext(ctx);
  return rows;
}

async function newUser(): Promise<string> {
  const [row] = await sql<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [
    `sweep_${crypto.randomUUID()}@example.test`,
  ]);
  const id = row?.id ?? "";
  created.push(id);
  return id;
}

const crossing = (subject: string, nowMs: number) => ({
  signal: "targeted_account" as const,
  signalClass: "account" as const,
  subjectKind: "account" as const,
  subject,
  windowStartMs: nowMs - 3_600_000,
  windowEndMs: nowMs,
  observed: 30,
  events: 30,
  threshold: 30,
  severity: "critical" as const,
  byRoute: { "/auth/login": 30 },
});

describe("sweepForgottenAccounts (R2-1)", () => {
  it("a forget LOST by a failing ledger call is recovered by the sweep: anonymised and deleted accounts, live control kept", { timeout: 60_000 }, async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = env.SECURITY_LEDGER.getByName(`sweep-${crypto.randomUUID()}`);
    const [anonymised, deleted, live] = [await newUser(), await newUser(), await newUser()];
    const now = Date.now();
    await runInDurableObject(ledger, async (l) => {
      quiet(l);
      for (const id of [anonymised, deleted, live]) await l.reportAt({ reports: [crossing(id, now), crossing(id, now)], countedOverflow: {} }, now);
    });
    const rowsFor = (id: string) =>
      runInDurableObject(ledger, (_l, s) =>
        s.storage.sql
          .exec<{ n: number }>(
            `SELECT (SELECT COUNT(*) FROM account_refs WHERE user_id = ?1)
                  + (SELECT COUNT(*) FROM held WHERE subject_kind = 'account' AND subject = ?1) AS n`,
            id,
          )
          .one().n,
      );
    // The reaper's forget, LOST: the ledger call fails (logged once, continued).
    const failing = { ...env, SECURITY_LEDGER: { getByName: () => ({ forgetAccount: async () => Promise.reject(new Error("down")) }) } };
    await forgetAccountEverywhere(failing as unknown as Env, anonymised, "anonymise-accounts");
    expect(err).toHaveBeenCalled();
    await sql("UPDATE users SET anonymised_at = now() WHERE id = $1", [anonymised]);
    await sql("DELETE FROM users WHERE id = $1", [deleted]);
    expect([await rowsFor(anonymised), await rowsFor(deleted), await rowsFor(live)]).toEqual([2, 2, 2]); // positive control

    const ctx = createExecutionContext();
    const counts = await sweepForgottenAccounts(env, ctx, ledger);
    await waitOnExecutionContext(ctx);
    expect([await rowsFor(anonymised), await rowsFor(deleted), await rowsFor(live)]).toEqual([0, 0, 2]);
    // Step 1 (anonymised in the last 3 days) forgot `anonymised`; step 2 then found
    // only `deleted` and `live` in the ledger, and forgot the one Postgres no longer has.
    expect(counts?.recentAnonymised).toBeGreaterThanOrEqual(1);
    expect(counts?.recentAnonymised).toBeLessThanOrEqual(SWEEP_BATCH);
    expect(counts?.ledgerChecked).toBe(2);
    expect(counts?.ledgerForgotten).toBe(1);

    // Idempotent: a second run forgets nothing more and still keeps the live account.
    const again = await sweepForgottenAccounts(env, createExecutionContext(), ledger);
    expect(again?.ledgerForgotten).toBe(0);
    expect(await rowsFor(live)).toBe(2);
    // The tombstone the sweep left stops a late report re-creating the anonymised account's rows.
    await runInDurableObject(ledger, (l) => l.reportAt({ reports: [crossing(anonymised, now + 1)], countedOverflow: {} }, now + 1));
    expect(await rowsFor(anonymised)).toBe(0);
  });

  it("is bounded per run: the ledger page never exceeds SWEEP_BATCH, and its cursor wraps to visit every id", { timeout: 60_000 }, async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = env.SECURITY_LEDGER.getByName(`sweep-${crypto.randomUUID()}`);
    await runInDurableObject(ledger, (_l, s) => {
      for (let i = 0; i < SWEEP_BATCH + 5; i++) {
        s.storage.sql.exec("INSERT INTO account_refs (user_id, ref, last_used_ms) VALUES (?, ?, ?)", `ghost-${String(i).padStart(4, "0")}`, `r${i}`, Date.now());
      }
    });
    const first = await sweepForgottenAccounts(env, createExecutionContext(), ledger);
    const second = await sweepForgottenAccounts(env, createExecutionContext(), ledger);
    expect([first?.ledgerChecked, second?.ledgerChecked]).toEqual([SWEEP_BATCH, 5]);
    const left = await runInDurableObject(ledger, (_l, s) => s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM account_refs").one().n);
    expect(left).toBe(0); // none of the ghosts is a live user
  });
});
```

```diff
--- a/apps/api/src/auth/anonymise-accounts.ts
+++ b/apps/api/src/auth/anonymise-accounts.ts
@@ -52,6 +52,7 @@
 import type { Client } from "pg";
 
 import { BEGIN_BOUNDED_TX, withClient } from "../db/client";
+import { forgetAll } from "../security/forget";
 
 import { hasReservedEmailKey, ReservedEmailKeyMissingError, reservedEmailHmac } from "./reserved-email";
 
@@ -115,6 +116,8 @@
   if (candidates.length === 0) return 0;
 
   let scrubbed = 0;
+  // Accounts scrubbed in this run, for the security clean-up after the loop.
+  const forgotten: string[] = [];
   let skipped = 0; // the re-check said no (a hold, a cancel, a changed row)
   let failed = 0; // a bump or the scrub threw; the row is retried next run
   await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
@@ -162,9 +165,17 @@
       } catch (err) {
         console.error(`anonymise-accounts: post-scrub epoch bump failed for ${id}; step 5a still refuses writes`, err);
       }
+      forgotten.push(id);
     }
   });
 
+  // security-alerting §2.6 N7, §4.5: forget each scrubbed account in the ledger
+  // (PR 2: and its browsers and pending notices). AWAITED, after `withClient`
+  // returned, so every row lock is released first (the RF6 lock tests time the
+  // loop) and the run does not end before the forgets do. Never throws; each
+  // call is logged and continued on failure, and the nightly sweep
+  // (src/security/forget-sweep.ts) re-forgets anything a failure left behind.
+  await forgetAll(env, forgotten, "anonymise-accounts");
   const n = candidates.length;
   const summary = `anonymise-accounts: anonymised ${scrubbed}, skipped (re-check) ${skipped}, failed ${failed} of ${n}`;
   if (failed > 0) console.error(summary);
```

```diff
--- a/apps/api/src/auth/reap-unverified.ts
+++ b/apps/api/src/auth/reap-unverified.ts
@@ -28,6 +28,7 @@
  * nightly run reconsiders it.
  */
 import { withClient } from "../db/client";
+import { forgetAll } from "../security/forget";
 
 /**
  * Caps one run's DELETE so a pathological backlog cannot turn a routine cron
@@ -54,13 +55,13 @@
   env: Env,
   ctx: ExecutionContext,
 ): Promise<number> {
-  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
+  const ids = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
     // ⚠️ A HELD ACCOUNT IS NEVER REAPED, even unverified and stale: deleting
     // it would take the user AND THE EVIDENCE the hold preserves. A ban or
     // suspension alone does not spare it (see the file header). AC-3 (as
     // reworded by the account-legal-hold spec); test/reap-unverified.test.ts
     // pins it against this function.
-    const { rowCount } = await c.query(
+    const { rows } = await c.query<{ id: string }>(
       `DELETE FROM users
         WHERE id IN (
           SELECT id FROM users
@@ -71,11 +72,17 @@
            ORDER BY created_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED
-        )`,
+        )
+       RETURNING id`,
       [REAP_BATCH],
     );
-    return rowCount ?? 0;
+    return rows.map((r) => r.id);
   });
+  // security-alerting §2.6 N7, §4.5: the same clean-up as the anonymise reaper,
+  // per deleted id, AWAITED after `withClient` returned (the lock is released).
+  // The nightly sweep (R2-1, src/security/forget-sweep.ts) re-forgets whatever a failure left.
+  await forgetAll(env, ids, "reap-unverified");
+  const n = ids.length;
   if (n > 0) {
     console.log(`reap-unverified: deleted ${n} account(s)`);
   }
```

- [ ] **Step 3: GREEN.** `…/api test -- test/anonymise-accounts.test.ts test/reap-unverified.test.ts test/security-forget-sweep.test.ts`. Mutation control (executed): skip the sweep's ledger reconcile (`void gone;`) — "a forget LOST … is recovered by the sweep" goes RED; restore.

### Task 14: PR 1 gate

- [ ] `pnpm typecheck`; `pnpm --filter @thinkersjournal/shared test`; the api suite (`TEST_DATABASE_URL=…_appeals`, `--exclude test/migrations.db.test.ts`); `pnpm --filter @thinkersjournal/web test`. Read failures by name against the merge-base, never by count.
- [ ] **Re-run the spec's grep** (`logSecurityEvent(` in `apps/` and `packages/`, tests excluded): the five callers and the definition, nothing else (control: the same grep before this PR found the same six).
- [ ] **Deploy order** (§2.2 item 4): the api deploys the classes (migration `v4`) before the web Worker deploys its binding. Say so in the PR body.
- [ ] PR body: "Part of the security-alerting work (spec #153)", the dispatcher-snapshot diff, the spec amendment (I-8), and the version line left for the PM.

---

# PR 2 — device cookie, device list, notices (Tasks 15–23)

Branch from `main` after PR 1 merges. Flags stay off: with `ACCOUNT_NOTICES_ENABLED="0"` every would-be notice is one `account-notice: would_send <kind>` log line and claims nothing, but browsers are recorded from the first deploy (§6).

⚠️ **Deploy precondition (PM ruling I-3): `DEVICE_HASH_KEY` is set in production, by Task 22's runbook procedure, BEFORE this PR merges.** §6's phase-1 row has the key set and device recording running from phase 1; without the key, recording is silently off and the 1b rollout wave is not reduced.

### Task 15: The account-notices module and the country header constant

**Files:** replace `packages/shared/src/account-notices.ts`; modify `packages/shared/src/client-ip.ts`; replace `packages/shared/test/account-notices.test.ts`.

**Produces** (§4.1 and §4.2 `ts` blocks, verbatim, joined): `AccountNoticeKind`, `DeviceRecordMode`, `DeviceHashes`, `SignInRecord`, `NoticeClaim`, `UserSecurityNoticeRpc`, `NOTICE_CAPS`, `PendingNotice`, `NoticeState`, `PostmarkOutcome`, `classifyPostmark`, `NOTICE_MAX_AGE_MS`, `noticeRetryDelayMs`, `foldedDueMs`, `DEVICE_TTL_MS`, `isNewSignIn`, `capAllows`, `capReopensAt`, `WAVE_SPREAD_MS`, `noticeNotBefore`, `NOTICE_MAX_DELAY_MS`, `DEVICE_COOKIE`, `DEV_DEVICE_COOKIE`, `buildDeviceCookie`, `DeviceKeys`, `resolveDeviceKeys`, `deviceHash`, `keyId`, `deviceHashes`, `NoticeInput`, `SignInNoticeInput`, `NoticeText`, `newSignInNotice`, `passwordResetNotice`; `CLIENT_COUNTRY_HEADER = "X-TJ-Client-Country"`.

- [ ] **Step 1: RED.** The test file becomes:

```ts
import { describe, expect, it } from "vitest";

import {
  buildDeviceCookie,
  capAllows,
  capReopensAt,
  classifyPostmark,
  deviceHash,
  deviceHashes,
  foldedDueMs,
  keyId,
  newSignInNotice,
  NOTICE_MAX_AGE_MS,
  noticeNotBefore,
  noticeRetryDelayMs,
  passwordResetNotice,
  resolveDeviceKeys,
  WAVE_SPREAD_MS,
} from "../src/account-notices";

const H = 3_600_000;
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const URL_ = "https://community.thinkersjournal.com/forgot-password";

describe("classifyPostmark (PR 1; security-alerting spec §4.4)", () => {
  it.each([
    [{ ok: true } as const, "sent"],
    [{ ok: false, status: 422, errorCode: 300 } as const, "permanent"],
    [{ ok: false, status: 422, errorCode: 406 } as const, "permanent"],
    [{ ok: false, status: 422, errorCode: 10 } as const, "transient"],
    [{ ok: false, status: 422, errorCode: 412 } as const, "transient"],
    [{ ok: false, status: 422, errorCode: 1480 } as const, "transient"],
    [{ ok: false, status: 429, errorCode: null } as const, "transient"],
    [{ ok: false, status: 500, errorCode: null } as const, "transient"],
    [{ ok: false, status: null, errorCode: null } as const, "transient"],
  ])("%j → %s", (outcome, want) => expect(classifyPostmark(outcome)).toBe(want));
});

describe("caps, folds and retries (PR 2)", () => {
  it("noticeRetryDelayMs: 15, 30, 60, 120, 240, then 360 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => noticeRetryDelayMs(n) / 60_000)).toEqual([15, 30, 60, 120, 240, 360, 360]);
  });

  it("three sends in the hour close the cap; it reopens when the oldest is an hour old", () => {
    const sent = [NOW - 50 * 60_000, NOW - 20 * 60_000, NOW - 5 * 60_000];
    expect(capAllows(sent, NOW, "new_sign_in")).toBe(false);
    expect(capReopensAt(sent, NOW, "new_sign_in")).toBe(NOW + 10 * 60_000);
  });

  it("capReopensAt is never more than 24 h after now", () => {
    const sent = Array.from({ length: 10 }, (_, i) => NOW - i * 2 * H);
    expect(capReopensAt(sent, NOW, "new_sign_in") - NOW).toBeLessThanOrEqual(24 * H);
  });

  it("foldedDueMs keeps the earlier due time and never goes before the cap reopens", () => {
    expect(foldedDueMs(NOW + 2 * H, NOW + 5 * H, NOW)).toBe(NOW + 2 * H);
    expect(foldedDueMs(NOW + 2 * H, NOW + 1 * H, NOW)).toBe(NOW + 1 * H);
    expect(foldedDueMs(NOW + 2 * H, NOW + 1 * H, NOW + 3 * H)).toBe(NOW + 3 * H);
    expect(foldedDueMs(null, NOW, NOW + H)).toBe(NOW + H);
  });

  it("a wave sign-in is spread inside WAVE_SPREAD_MS; any other is now", () => {
    const wave = { knownDevice: false, listWasEmpty: false, unknownKeysOnly: true };
    expect(noticeNotBefore(wave, NOW, () => 0.5)).toBe(NOW + WAVE_SPREAD_MS / 2);
    expect(noticeNotBefore({ ...wave, unknownKeysOnly: false }, NOW, () => 0.5)).toBe(NOW);
  });

  it("transient refusals end after 7 days: ~32 attempts", () => {
    let t = 0;
    let n = 0;
    while (t < NOTICE_MAX_AGE_MS) t += noticeRetryDelayMs(++n);
    expect(n).toBeGreaterThanOrEqual(30);
    expect(n).toBeLessThanOrEqual(33);
  });
});

describe("device keys and hashes (PR 2; N5)", () => {
  it("no key → null (device notices disabled); an empty _PREV is no previous key", () => {
    expect(resolveDeviceKeys({})).toBeNull();
    expect(resolveDeviceKeys({ DEVICE_HASH_KEY: "" })).toBeNull();
    expect(resolveDeviceKeys({ DEVICE_HASH_KEY: "k1", DEVICE_HASH_KEY_PREV: "" })).toEqual({ current: "k1", prev: null });
  });

  it("one token under two user ids → two unrelated hashes, neither the token's plain SHA-256", async () => {
    const token = "A".repeat(43);
    const a = await deviceHash("k1", "user-a", token);
    const b = await deviceHash("k1", "user-b", token);
    expect(a).not.toBe(b);
    const plain = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
    expect(a).not.toBe(plain);
  });

  it("deviceHashes carries both keys' ids during a rotation", async () => {
    const h = await deviceHashes({ current: "k2", prev: "k1" }, "u", "A".repeat(43));
    expect(h.currentKid).toBe(await keyId("k2"));
    expect(h.prevKid).toBe(await keyId("k1"));
    expect(h.prev).toBe(await deviceHash("k1", "u", "A".repeat(43)));
  });

  it("the cookie strings, both pinned", () => {
    expect(buildDeviceCookie({}, "tok")).toBe("__Host-tj_device=tok; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000");
    expect(buildDeviceCookie({ TEST_ROUTES: "1" }, "tok")).toBe("tj_device_dev=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000");
  });
});

describe("notice text (PR 2; §4.2)", () => {
  const base = { at: new Date(NOW), coalesced: null, forgotPasswordUrl: URL_ };

  it("names the country, never an IP; a bad code omits the phrase", () => {
    expect(newSignInNotice({ ...base, country: "DE", listWasEmpty: false }).textBody).toContain("(approximate)");
    expect(newSignInNotice({ ...base, country: "de", listWasEmpty: false }).textBody).not.toContain(" from ");
    expect(newSignInNotice({ ...base, country: null, listWasEmpty: false }).textBody).not.toContain(" from ");
  });

  it("the empty-list sentence appears only for an empty list", () => {
    expect(newSignInNotice({ ...base, country: null, listWasEmpty: true }).textBody).toContain("had no browser on record");
    expect(newSignInNotice({ ...base, country: null, listWasEmpty: false }).textBody).not.toContain("had no browser on record");
  });

  it("a coalesced notice says how many others since when", () => {
    const c = { count: 1, since: new Date(NOW - H) };
    expect(newSignInNotice({ ...base, coalesced: c, country: null, listWasEmpty: false }).textBody).toContain(
      "also covers 1 other new sign-in since 2026-10-07T11:00:00.000Z",
    );
    expect(passwordResetNotice({ ...base, country: null }).textBody).toContain(URL_);
  });
});
```

- [ ] **Step 2: Implement.** Replace the file with the spec's §4.1 block followed by its §4.2 block, verbatim.

The file is the spec block exactly (checked byte for byte, LF, when this plan was generated).

```diff
--- a/packages/shared/src/client-ip.ts
+++ b/packages/shared/src/client-ip.ts
@@ -13,3 +13,12 @@
  * same reasoning as SESSION_COOKIE_NAME in ./cookie.
  */
 export const CLIENT_IP_HEADER = 'X-TJ-Client-IP';
+
+/**
+ * Header the `web` Worker sets, on every call over the `API` Service Binding,
+ * carrying the edge's ISO 3166-1 alpha-2 country for the ORIGINAL request
+ * (security-alerting spec §4.2). Same delete-then-set discipline as
+ * CLIENT_IP_HEADER: only ever the web Worker's own value reaches the api. Used
+ * only for the account-holder notices' "from <country> (approximate)" phrase.
+ */
+export const CLIENT_COUNTRY_HEADER = 'X-TJ-Client-Country';
```

- [ ] **Step 3: GREEN.** `pnpm --filter @thinkersjournal/shared test -- test/account-notices.test.ts`.

### Task 16: Device keys, the cookie on the response path, and P-10

**Files:** create `apps/api/src/security/device-cookie.ts`, `apps/api/test/device-cookie.test.ts`; modify `apps/api/src/worker-configuration.d.ts`, `apps/api/vitest.config.ts`, `apps/api/src/db/client.ts`.

**Produces:** `DeviceCookie { token; setCookie: string | null }`, `deviceCookieName(env)`, `readDeviceToken(request, env)`, `deviceCookieFor(request, env)`, `sessionAndDeviceHeaders(sessionCookie, device, json): Headers` (session first, then device), `clientCountry(request)` (P-15b).

- [ ] **Step 1: RED.**

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { clientCountry, deviceCookieFor, readDeviceToken, sessionAndDeviceHeaders } from "../src/security/device-cookie";

import { createVerifiedActor, deleteCreatedUsers } from "./actor";

afterEach(() => deleteCreatedUsers());

/**
 * The device cookie on the response path (security-alerting spec §4.1; plan
 * Task 14). The suite runs with TEST_ROUTES="1", so the dev name is the live
 * one here; the production string is pinned in packages/shared's tests.
 */
const GOOD = "A".repeat(43);
const req = (cookie?: string, headers: Record<string, string> = {}) =>
  new Request("https://api.test/", { headers: cookie === undefined ? headers : { ...headers, Cookie: cookie } });

describe("readDeviceToken / deviceCookieFor", () => {
  it("reuses a well-formed cookie and mints nothing", () => {
    expect(readDeviceToken(req(`tj_session=x; tj_device_dev=${GOOD}`), env)).toBe(GOOD);
    expect(deviceCookieFor(req(`tj_device_dev=${GOOD}`), env)).toEqual({ token: GOOD, setCookie: null });
  });

  it.each(["", "short", `${GOOD}A`, `${"A".repeat(42)}=`, `${"A".repeat(42)}!`])(
    "treats %j as absent and mints a fresh 43-character token",
    (value) => {
      const d = deviceCookieFor(req(`tj_device_dev=${value}`), env);
      expect(d.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(d.setCookie).toBe(`tj_device_dev=${d.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`);
    },
  );

  it("never reads the production name in dev, nor the dev name in production", () => {
    expect(readDeviceToken(req(`__Host-tj_device=${GOOD}`), env)).toBeNull();
    expect(readDeviceToken(req(`tj_device_dev=${GOOD}`), { TEST_ROUTES: undefined })).toBeNull();
    expect(readDeviceToken(req(`__Host-tj_device=${GOOD}`), {})).toBe(GOOD);
  });

  it("the session cookie comes first, then the device cookie: two distinct Set-Cookie headers", () => {
    const h = sessionAndDeviceHeaders("tj_session=s; Path=/", { token: GOOD, setCookie: `tj_device_dev=${GOOD}` }, true);
    expect(h.getSetCookie()).toEqual(["tj_session=s; Path=/", `tj_device_dev=${GOOD}`]);
    expect(h.get("content-type")).toBe("application/json");
  });

  it("country: two capital letters from X-TJ-Client-Country, else CF-IPCountry, else null; never anything else", () => {
    expect(clientCountry(req(undefined, { "X-TJ-Client-Country": "DE" }))).toBe("DE");
    expect(clientCountry(req(undefined, { "CF-IPCountry": "FR" }))).toBe("FR");
    expect(clientCountry(req(undefined, { "X-TJ-Client-Country": "de" }))).toBeNull();
    expect(clientCountry(req(undefined, { "X-TJ-Client-Country": "203.0.113.9" }))).toBeNull();
    expect(clientCountry(req())).toBeNull();
  });
});

describe("logout and logout-all leave the device cookie alone (§4.1)", () => {
  it.each(["/auth/logout", "/auth/logout-all"])("%s's Set-Cookie list names only the session cookie", async (path) => {
    const actor = await createVerifiedActor();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://api.test${path}`, {
        method: "POST",
        headers: { Origin: "http://localhost:8787", Cookie: `${actor.cookie}; tj_device_dev=${GOOD}`, "X-CSRF-Token": actor.csrfToken },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const names = res.headers.getSetCookie().map((c) => c.split("=")[0]);
    expect(names).toEqual(["tj_session"]);
  });
});
```

- [ ] **Step 2: Implement.**

```ts
/**
 * The device cookie on the api's response path (security-alerting spec §4.1).
 * A well-formed `__Host-tj_device` (dev/CI: `tj_device_dev`) is reused; anything
 * else gets a fresh 32-byte token minted on the response. Nothing here is
 * awaited on I/O: a cookie read, and at most one more `Set-Cookie`.
 */
import { buildDeviceCookie, CLIENT_COUNTRY_HEADER, DEV_DEVICE_COOKIE, DEVICE_COOKIE } from "@thinkersjournal/shared";

import { base64urlEncode } from "../auth/encoding";

/** 32 bytes, base64url without padding. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

export interface DeviceCookie {
  /** The browser's token: the one it sent, or the one minted now. */
  readonly token: string;
  /** The `Set-Cookie` value to add, or null when the browser already holds a good one. */
  readonly setCookie: string | null;
}

/** The cookie name this environment uses: the same `TEST_ROUTES === "1"` gate as the session cookie. */
export function deviceCookieName(env: { readonly TEST_ROUTES?: string }): string {
  return env.TEST_ROUTES === "1" ? DEV_DEVICE_COOKIE : DEVICE_COOKIE;
}

/** The well-formed token on `request`, or null. A malformed value is treated as absent. */
export function readDeviceToken(request: Request, env: { readonly TEST_ROUTES?: string }): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) return null;
  const name = deviceCookieName(env);
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1 || trimmed.slice(0, eq) !== name) continue;
    const value = trimmed.slice(eq + 1);
    return TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

export function deviceCookieFor(request: Request, env: { readonly TEST_ROUTES?: string }): DeviceCookie {
  const existing = readDeviceToken(request, env);
  if (existing !== null) return { token: existing, setCookie: null };
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  return { token, setCookie: buildDeviceCookie(env, token) };
}

/** The session cookie, then the device cookie when one is minted: two distinct `Set-Cookie` headers. */
export function sessionAndDeviceHeaders(sessionCookie: string, device: DeviceCookie | null, json: boolean): Headers {
  const headers = new Headers();
  if (json) headers.set("content-type", "application/json");
  headers.append("Set-Cookie", sessionCookie);
  if (device !== null && device.setCookie !== null) headers.append("Set-Cookie", device.setCookie);
  return headers;
}

/** The edge's country for the original request, or null. Never an IP (§4.2). */
export function clientCountry(request: Request): string | null {
  const value = request.headers.get(CLIENT_COUNTRY_HEADER) ?? request.headers.get("CF-IPCountry");
  return value !== null && COUNTRY_RE.test(value) ? value : null;
}
```

```diff
--- a/apps/api/src/worker-configuration.d.ts
+++ b/apps/api/src/worker-configuration.d.ts
@@ -79,6 +79,12 @@
 	ACCOUNT_NOTICES_ENABLED: string;
 	SECURITY_ALERT_EMAIL?: string;
 	SECURITY_ALERT_RELAY_TOKEN?: string;
+	// Security alerting PR 2 (spec §4.1, N5): the device-list HMAC keys. Optional
+	// on purpose: a missing or empty DEVICE_HASH_KEY DISABLES device notices
+	// (resolveDeviceKeys returns null). Rotate ONLY with _PREV set
+	// (docs/runbooks/deploy.md).
+	DEVICE_HASH_KEY?: string;
+	DEVICE_HASH_KEY_PREV?: string;
 	// Build-identity (2026-09-24) — added by hand, same reason as CF_ACCESS_*
 	// above: a full `wrangler types` regeneration in this checkout drops
 	// several hand-added bindings and pulls in an unrelated diff. See
```

```diff
--- a/apps/api/vitest.config.ts
+++ b/apps/api/vitest.config.ts
@@ -188,6 +188,12 @@
                 // api.cloudflare.com; this only keeps the binding present.
                 CACHE_PURGE_TOKEN: "test-cache-purge-token",
                 CACHE_PURGE_ZONE_ID: "test-zone-id",
+                // A SECRET (security alerting PR 2, src/security/account-notices-flow.ts):
+                // the device-list HMAC key. A fixed dummy, never the production key.
+                // DEVICE_HASH_KEY_PREV is deliberately absent: tests that rotate pass
+                // their own env. The three alerting FLAGS come from wrangler.jsonc's
+                // `vars`, which the pool reads through `configPath` above.
+                DEVICE_HASH_KEY: "test-device-hash-key",
               },
             },
           }),
```

```diff
--- a/apps/api/src/db/client.ts
+++ b/apps/api/src/db/client.ts
@@ -71,7 +71,7 @@
  */
 export async function withClient<T>(
   hd: Hyperdrive,
-  ctx: ExecutionContext,
+  ctx: Pick<ExecutionContext, "waitUntil">,
   fn: (client: Client) => Promise<T>,
 ): Promise<T> {
   const client = new pg.Client({ connectionString: hd.connectionString });
```

- [ ] **Step 3: GREEN.** `…/api test -- test/device-cookie.test.ts`; `pnpm --filter @thinkersjournal/api typecheck` (P-10 must leave every existing `withClient` caller green).

### Task 17: `UserSecurityDO` — device list, caps, pending and in-flight notice, alarm

**Files:** create `apps/api/src/security/user-devices.ts`, `apps/api/src/security/account-notice-send.ts`; replace `apps/api/src/durable-objects/UserSecurityDO.ts` (its epoch half is unchanged).

**Produces:** the `UserSecurityNoticeRpc` methods (§4.1) — `recordDevice`, `claimNotice`, `forgetDevices`, `dropPendingNotices` — plus `settleClaim(kind, atMs, result, nowMs)` (P-5), `alarm()`/`alarmAt(nowMs)`, seams `noticeSender`, `ledgerFor`, `armAt`; `logNoticeEnd(state, kind)`; `mergePending`, `detachPending`, `writeClaimed`, `takeClaimed`; `NoticeFacts`, `NoticeSendResult`, `noticeText(f)`, `noticeHtml(text)`, `sendNotice(env, ctx, userId, facts)`, `FORGOT_PASSWORD_URL` (from `CANONICAL_ORIGIN`, `auth/email-verify.ts:38`, never a request). Tables (in the constructor, so no wrangler migration): `known_devices`, `notices`, `pending_notice`, `inflight_notice` (I-2), `claimed_notice` (R2-3), `owner` (P-7).

⚠️ **No delete-after-await (I-2).** The alarm detaches the due notice into `inflight_notice` before awaiting the address lookup and Postmark, so a sign-in folded meanwhile lands in a fresh `pending_notice` row; settle touches only the in-flight row (sent → delete; transient → merged back with the backoff; a drop state → delete and log). An in-flight row left by an eviction is merged back at the next alarm, and so is a route's claim past its due time (R2-3). An unknown owner is retried, logged `owner_unknown` (I-9).

- [ ] **Step 0: Implementer confirmations 7 and 8.** On a deployed Worker, Hyperdrive and outbound `fetch` work from inside `UserSecurityDO`, and `this.ctx.id.name` is populated for a `getByName` stub (both pass in the pool). If either fails, stop and return the work to the PM (§4.4: "there is no fallback path").
- [ ] **Step 1: RED** — the behaviour is pinned through the flows in Task 19; write that file first.
- [ ] **Step 2: Implement.**

```ts
/**
 * `UserSecurityDO`'s device list and notice tables (security-alerting spec §4.1,
 * §4.4). Synchronous functions over the DO's SQLite, so `UserSecurityDO` can run
 * each RPC in one `transactionSync`. Created in the DO's constructor beside the
 * `security` table, so there is no wrangler migration (§4.1).
 */
import {
  capAllows,
  capReopensAt,
  foldedDueMs,
  noticeRetryDelayMs,
  type AccountNoticeKind,
  type DeviceHashes,
  type DeviceRecordMode,
  type NoticeClaim,
  type PendingNotice,
  type SignInRecord,
} from "@thinkersjournal/shared";

/** At most this many browsers per account; the least recently seen is evicted (§4.1). */
export const DEVICE_LIST_CAP = 20;
const DAY_MS = 86_400_000;

export const USER_DEVICE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS known_devices (device_hash TEXT PRIMARY KEY, kid TEXT NOT NULL,
     first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL) WITHOUT ROWID`,
  "CREATE TABLE IF NOT EXISTS notices (kind TEXT NOT NULL, sent_ms INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS notices_kind_sent ON notices (kind, sent_ms)",
  `CREATE TABLE IF NOT EXISTS pending_notice (kind TEXT PRIMARY KEY, count INTEGER NOT NULL,
     first_event_ms INTEGER NOT NULL, last_event_ms INTEGER NOT NULL, last_country TEXT,
     list_was_empty INTEGER NOT NULL, due_ms INTEGER NOT NULL, attempts INTEGER NOT NULL) WITHOUT ROWID`,
  // Plan ruling P-7: the alarm sends a deferred notice with no request in hand, so it needs the user id.
  "CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL)",
  // Audit I-2: the notice being SENT, detached from `pending_notice` before the
  // alarm awaits Postmark, so a sign-in folded meanwhile lands in a fresh
  // pending row instead of being deleted or overwritten on settle.
  `CREATE TABLE IF NOT EXISTS inflight_notice (kind TEXT PRIMARY KEY, count INTEGER NOT NULL,
     first_event_ms INTEGER NOT NULL, last_event_ms INTEGER NOT NULL, last_country TEXT,
     list_was_empty INTEGER NOT NULL, due_ms INTEGER NOT NULL, attempts INTEGER NOT NULL) WITHOUT ROWID`,
  // R2-3: a notice a ROUTE claimed for an immediate send, with its folds, written
  // in the same transaction that took it out of `pending_notice`. The route
  // settles it; if the route is cut off, the alarm recovers it at `due_ms`.
  `CREATE TABLE IF NOT EXISTS claimed_notice (kind TEXT NOT NULL, count INTEGER NOT NULL,
     first_event_ms INTEGER NOT NULL, last_event_ms INTEGER NOT NULL, last_country TEXT,
     list_was_empty INTEGER NOT NULL, due_ms INTEGER NOT NULL, attempts INTEGER NOT NULL,
     PRIMARY KEY (kind, last_event_ms)) WITHOUT ROWID`,
];

type NoticeTable = "pending_notice" | "inflight_notice" | "claimed_notice";

type DeviceRow = { device_hash: string; kid: string };
type PendingRow = {
  kind: string;
  count: number;
  first_event_ms: number;
  last_event_ms: number;
  last_country: string | null;
  list_was_empty: number;
  due_ms: number;
  attempts: number;
};

/** §4.1: `signup` clears then records; `reset` clears all but this browser; `login` records. */
export function recordDeviceSync(sql: SqlStorage, h: DeviceHashes, nowMs: number, mode: DeviceRecordMode): SignInRecord {
  const entries = sql.exec<DeviceRow>("SELECT device_hash, kid FROM known_devices").toArray();
  const listWasEmpty = entries.length === 0;
  const matched = entries.find((e) => e.device_hash === h.current || (h.prev !== null && e.device_hash === h.prev));
  const kids = new Set([h.currentKid, h.prevKid]);
  const unknownKeysOnly = !listWasEmpty && !entries.some((e) => kids.has(e.kid));
  if (mode !== "login") {
    sql.exec("DELETE FROM known_devices");
  } else if (matched !== undefined && matched.device_hash !== h.current) {
    // A `prev` match is rewritten to the `current` hash in place (N5).
    sql.exec(
      "UPDATE known_devices SET device_hash = ?, kid = ? WHERE device_hash = ?",
      h.current,
      h.currentKid,
      matched.device_hash,
    );
  }
  sql.exec(
    `INSERT INTO known_devices (device_hash, kid, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(device_hash) DO UPDATE SET kid = excluded.kid, last_seen = excluded.last_seen`,
    h.current,
    h.currentKid,
    nowMs,
    nowMs,
  );
  sql.exec(
    `DELETE FROM known_devices WHERE device_hash IN (
       SELECT device_hash FROM known_devices ORDER BY last_seen DESC LIMIT -1 OFFSET ?)`,
    DEVICE_LIST_CAP,
  );
  return { knownDevice: matched !== undefined, listWasEmpty, unknownKeysOnly };
}

export function readPending(sql: SqlStorage, kind: AccountNoticeKind, table: NoticeTable = "pending_notice"): PendingNotice | null {
  const row = sql.exec<PendingRow>(`SELECT * FROM ${table} WHERE kind = ?`, kind).toArray()[0];
  return row === undefined ? null : toPending(row);
}

export function allPending(sql: SqlStorage, table: NoticeTable = "pending_notice"): PendingNotice[] {
  return sql.exec<PendingRow>(`SELECT * FROM ${table} ORDER BY due_ms`).toArray().map(toPending);
}

function toPending(row: PendingRow): PendingNotice {
  return {
    kind: row.kind as AccountNoticeKind,
    count: row.count,
    firstEventMs: row.first_event_ms,
    lastEventMs: row.last_event_ms,
    lastCountry: row.last_country,
    listWasEmpty: row.list_was_empty === 1,
    dueMs: row.due_ms,
    attempts: row.attempts,
  };
}

export function writePending(sql: SqlStorage, p: PendingNotice, table: NoticeTable = "pending_notice"): void {
  sql.exec(
    `INSERT INTO ${table} (kind, count, first_event_ms, last_event_ms, last_country, list_was_empty, due_ms, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET count = excluded.count, first_event_ms = excluded.first_event_ms,
       last_event_ms = excluded.last_event_ms, last_country = excluded.last_country,
       list_was_empty = excluded.list_was_empty, due_ms = excluded.due_ms, attempts = excluded.attempts`,
    p.kind,
    p.count,
    p.firstEventMs,
    p.lastEventMs,
    p.lastCountry,
    p.listWasEmpty ? 1 : 0,
    p.dueMs,
    p.attempts,
  );
}

/**
 * Fold `p` into the kind's pending notice (or make it the pending notice): counts
 * add, the earliest first event and due time win, the latest event's time and
 * country are kept. Used for a requeue (P-5, CR-1) and a transient settle.
 */
export function mergePending(sql: SqlStorage, p: PendingNotice): void {
  const cur = readPending(sql, p.kind);
  if (cur === null) {
    writePending(sql, p);
    return;
  }
  const pLater = p.lastEventMs >= cur.lastEventMs;
  writePending(sql, {
    kind: p.kind,
    count: cur.count + p.count,
    firstEventMs: Math.min(cur.firstEventMs, p.firstEventMs),
    lastEventMs: pLater ? p.lastEventMs : cur.lastEventMs,
    lastCountry: pLater ? p.lastCountry : cur.lastCountry,
    listWasEmpty: cur.listWasEmpty || p.listWasEmpty,
    dueMs: Math.min(cur.dueMs, p.dueMs),
    attempts: Math.max(cur.attempts, p.attempts),
  });
}

/** Detach the kind's pending notice into `inflight_notice` (synchronous; call inside a transaction). */
export function detachPending(sql: SqlStorage, kind: AccountNoticeKind): PendingNotice | null {
  const p = readPending(sql, kind);
  if (p === null) return null;
  sql.exec("DELETE FROM pending_notice WHERE kind = ?", kind);
  writePending(sql, p, "inflight_notice");
  return p;
}

/** R2-3: record a route's send-now claim durably (folds included), retried at `dueMs` unless settled. */
export function writeClaimed(sql: SqlStorage, p: PendingNotice): void {
  sql.exec(
    `INSERT INTO claimed_notice (kind, count, first_event_ms, last_event_ms, last_country, list_was_empty, due_ms, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, last_event_ms) DO UPDATE SET count = count + excluded.count`,
    p.kind,
    p.count,
    p.firstEventMs,
    p.lastEventMs,
    p.lastCountry,
    p.listWasEmpty ? 1 : 0,
    p.dueMs,
    p.attempts,
  );
}

/** Take (read and delete) the claim a route made for the event at `atMs`; null if the alarm already recovered it. */
export function takeClaimed(sql: SqlStorage, kind: AccountNoticeKind, atMs: number): PendingNotice | null {
  const row = sql
    .exec<PendingRow>("SELECT * FROM claimed_notice WHERE kind = ? AND last_event_ms = ?", kind, atMs)
    .toArray()[0];
  if (row === undefined) return null;
  sql.exec("DELETE FROM claimed_notice WHERE kind = ? AND last_event_ms = ?", kind, atMs);
  return toPending(row);
}

export function sentTimes(sql: SqlStorage, kind: AccountNoticeKind, nowMs: number): number[] {
  return sql
    .exec<{ sent_ms: number }>("SELECT sent_ms FROM notices WHERE kind = ? AND sent_ms > ?", kind, nowMs - DAY_MS)
    .toArray()
    .map((r) => r.sent_ms);
}

export interface NoticeEvent {
  readonly atMs: number;
  readonly country: string | null;
  readonly listWasEmpty: boolean;
}

/** §4.4: send now (folding any pending notice in), or fold this event into the one pending notice. */
export function claimNoticeSync(
  sql: SqlStorage,
  kind: AccountNoticeKind,
  event: NoticeEvent,
  nowMs: number,
  notBeforeMs: number,
): NoticeClaim {
  const sent = sentTimes(sql, kind, nowMs);
  const pending = readPending(sql, kind);
  if (notBeforeMs <= nowMs && capAllows(sent, nowMs, kind)) {
    // R2-3: out of `pending_notice` and into `claimed_notice` in ONE transaction,
    // so a route cut off mid-send still leaves the notice (and its folds) on disk.
    sql.exec("DELETE FROM pending_notice WHERE kind = ?", kind);
    writeClaimed(sql, {
      kind,
      count: (pending?.count ?? 0) + 1,
      firstEventMs: pending?.firstEventMs ?? event.atMs,
      lastEventMs: event.atMs,
      lastCountry: event.country,
      listWasEmpty: (pending?.listWasEmpty ?? false) || event.listWasEmpty,
      dueMs: nowMs + noticeRetryDelayMs(1),
      attempts: 0,
    });
    sql.exec("INSERT INTO notices (kind, sent_ms) VALUES (?, ?)", kind, nowMs);
    return { send: "now", coalesced: pending === null ? null : { count: pending.count, sinceMs: pending.firstEventMs } };
  }
  const dueMs = foldedDueMs(pending?.dueMs ?? null, notBeforeMs, capReopensAt(sent, nowMs, kind));
  writePending(sql, {
    kind,
    count: (pending?.count ?? 0) + 1,
    firstEventMs: pending?.firstEventMs ?? event.atMs,
    lastEventMs: event.atMs,
    lastCountry: event.country,
    listWasEmpty: (pending?.listWasEmpty ?? false) || event.listWasEmpty,
    dueMs,
    attempts: pending?.attempts ?? 0,
  });
  return { send: "deferred", dueMs };
}
```

```ts
/**
 * Sends one account-holder notice (security-alerting spec §4.2, §4.4). Used by
 * the routes (an immediate notice) and by `UserSecurityDO`'s alarm (a deferred
 * one), so both build the same text from the same inputs. The link always comes
 * from `CANONICAL_ORIGIN`, never from a request (G2).
 *
 * ⚠️ NEVER LOGS the address, the user id or the body (postmark.ts's own rule).
 */
import {
  classifyPostmark,
  newSignInNotice,
  passwordResetNotice,
  type AccountNoticeKind,
  type NoticeText,
} from "@thinkersjournal/shared";

import { CANONICAL_ORIGIN, escapeHtml } from "../auth/email-verify";
import { postmarkSendOutcome } from "../auth/postmark";
import { withClient } from "../db/client";

/** The `forgot-password` link every notice carries (§4.3). */
export const FORGOT_PASSWORD_URL = `${CANONICAL_ORIGIN}/forgot-password`;

/** What happened to one send attempt. */
export type NoticeSendResult = "sent" | "permanent" | "transient" | "gone";

/** Everything a notice needs, with no request in hand (G2). */
export interface NoticeFacts {
  readonly kind: AccountNoticeKind;
  readonly atMs: number;
  readonly country: string | null;
  /** Earlier events folded in: count and the first one's time. Null for none. */
  readonly coalesced: { readonly count: number; readonly sinceMs: number } | null;
  readonly listWasEmpty: boolean;
}

export function noticeText(f: NoticeFacts): NoticeText {
  const input = {
    at: new Date(f.atMs),
    country: f.country,
    coalesced: f.coalesced === null ? null : { count: f.coalesced.count, since: new Date(f.coalesced.sinceMs) },
    forgotPasswordUrl: FORGOT_PASSWORD_URL,
  };
  return f.kind === "new_sign_in" ? newSignInNotice({ ...input, listWasEmpty: f.listWasEmpty }) : passwordResetNotice(input);
}

/** The text as HTML: escaped, with the link as an anchor (§4.2, like `sendPasswordResetEmail`). */
export function noticeHtml(text: NoticeText): string {
  const escaped = escapeHtml(text.textBody);
  const linked = escaped.replace(escapeHtml(FORGOT_PASSWORD_URL), `<a href="${escapeHtml(FORGOT_PASSWORD_URL)}">${escapeHtml(FORGOT_PASSWORD_URL)}</a>`);
  return linked
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** The live address, or null when the account no longer exists (§4.5: anonymised, reaped). */
async function liveAddress(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, userId: string): Promise<string | null> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ email: string }>(
      "SELECT email FROM users WHERE id = $1 AND anonymised_at IS NULL",
      [userId],
    );
    return rows[0]?.email ?? null;
  });
}

export async function sendNotice(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  userId: string,
  facts: NoticeFacts,
): Promise<NoticeSendResult> {
  const to = await liveAddress(env, ctx, userId);
  if (to === null) return "gone";
  const text = noticeText(facts);
  const outcome = await postmarkSendOutcome(env, {
    from: "noreply@thinkersjournal.com",
    to,
    subject: text.subject,
    textBody: text.textBody,
    htmlBody: noticeHtml(text),
    stream: "outbound",
  });
  return classifyPostmark(outcome);
}
```

```ts
/**
 * `UserSecurityDO` — a per-user monotonic "security epoch" counter, one
 * Durable Object instance per user (addressed via `getByName(userId)`).
 *
 * A session's `SessionData.securityEpoch` is stamped at login time. On every
 * revocation check (Tasks 16-17), the request handler compares that stamp
 * against the *current* epoch from this DO: if they differ, the session was
 * issued before the last `bumpEpoch()` call and is treated as revoked. This
 * lets "log out everywhere" / "force re-auth after password change" revoke
 * every outstanding session for a user in O(1) — no need to enumerate or
 * delete individual session records.
 *
 * Backed by the DO's SQLite storage (`new_sqlite_classes` — see
 * `wrangler.jsonc`), NOT in-memory state, so the epoch survives eviction,
 * hibernation, and redeploys.
 *
 * Security alerting PR 2 (docs/superpowers/specs/2026-10-07-security-alerting-design.md
 * §4.1, §4.4) adds the account's device list, its notice send times and its
 * one pending notice per kind, all in this object's SQLite, with an alarm that
 * enforces the 400-day device bound and sends deferred notices.
 */
import { DurableObject } from "cloudflare:workers";

import {
  DEVICE_TTL_MS,
  NOTICE_MAX_AGE_MS,
  noticeRetryDelayMs,
  type AccountNoticeKind,
  type DeviceHashes,
  type DeviceRecordMode,
  type NoticeClaim,
  type PendingNotice,
  type SignInRecord,
} from "@thinkersjournal/shared";

import { sendNotice, type NoticeFacts, type NoticeSendResult } from "../security/account-notice-send";
import {
  allPending,
  claimNoticeSync,
  detachPending,
  mergePending,
  recordDeviceSync,
  takeClaimed,
  USER_DEVICE_SCHEMA,
  type NoticeEvent,
} from "../security/user-devices";

const DAY_MS = 86_400_000;

interface SecurityRow extends Record<string, string | number | null> {
  epoch: number;
}

/** The one log line per ended notice (§4.4 G1): the state and the kind, never an id or an address. */
export function logNoticeEnd(state: string, kind: AccountNoticeKind): void {
  console.warn(`account-notice: dropped ${state} ${kind}`);
}

/** The ledger slice a Postmark drop is reported to (§4.4). */
export interface NoticeDropRpc {
  noticeDropped(endState: "dropped_permanent_refusal" | "dropped_expired"): Promise<void>;
}

export class UserSecurityDO extends DurableObject<Env> {
  /** TEST SEAM: the send a deferred notice uses. Tests replace it via `runInDurableObject`. */
  noticeSender: typeof sendNotice = sendNotice;
  /** TEST SEAM: where a Postmark drop is reported. */
  ledgerFor: () => NoticeDropRpc = () => this.env.SECURITY_LEDGER.getByName("ledger");
  /** TEST SEAM: where the next alarm goes (null clears it), so a real alarm never races `alarmAt`. */
  armAt: (ms: number | null) => Promise<void> = (ms) =>
    ms === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(ms);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Runs before any request this instance handles, and only once per
    // instance lifetime — safe to call unconditionally on every construction
    // because both the CREATE TABLE and the seed INSERT are idempotent.
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS security (
           id INTEGER PRIMARY KEY,
           epoch INTEGER NOT NULL DEFAULT 0
         )`,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO security (id, epoch) VALUES (1, 0)
         ON CONFLICT(id) DO NOTHING`,
      );
      for (const ddl of USER_DEVICE_SCHEMA) this.ctx.storage.sql.exec(ddl);
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /** The current security epoch for this user (starts at 0). */
  async getEpoch(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<SecurityRow>("SELECT epoch FROM security WHERE id = 1")
      .one();
    return Number(row.epoch);
  }

  /**
   * Atomically increments the epoch and returns the new value. Strictly
   * monotonic: each call increments by exactly 1.
   */
  async bumpEpoch(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<SecurityRow>(
        "UPDATE security SET epoch = epoch + 1 WHERE id = 1 RETURNING epoch",
      )
      .one();
    return Number(row.epoch);
  }

  /** Plan ruling P-7: remember whose object this is, for the alarm's deferred send. */
  private rememberOwner(): void {
    const name = this.ctx.id.name;
    if (name !== undefined) this.sql.exec("INSERT INTO owner (id, user_id) VALUES (1, ?) ON CONFLICT(id) DO NOTHING", name);
  }

  private owner(): string | null {
    return this.sql.exec<{ user_id: string }>("SELECT user_id FROM owner WHERE id = 1").toArray()[0]?.user_id ?? null;
  }

  /** §4.1: record this browser; `signup` and `reset` clear the list first (see `recordDeviceSync`). */
  async recordDevice(hashes: DeviceHashes, nowMs: number, mode: DeviceRecordMode): Promise<SignInRecord> {
    const record = this.ctx.storage.transactionSync(() => {
      this.rememberOwner();
      return recordDeviceSync(this.sql, hashes, nowMs, mode);
    });
    await this.rearm();
    return record;
  }

  /** §4.4: never drops a notice; sends now or folds it into the one pending notice of its kind. */
  async claimNotice(kind: AccountNoticeKind, event: NoticeEvent, nowMs: number, notBeforeMs: number): Promise<NoticeClaim> {
    const claim = this.ctx.storage.transactionSync(() => {
      this.rememberOwner();
      return claimNoticeSync(this.sql, kind, event, nowMs, notBeforeMs);
    });
    await this.rearm();
    return claim;
  }

  /**
   * Plan rulings P-5 and R2-3: the route reports how its immediate send of the
   * claim for the event at `atMs` ended. Sent or a drop state: the durable claim
   * is cleared. Transient (a refusal or a throw, CR-1): it becomes this kind's
   * pending notice, folded with any that arrived meanwhile, retried after
   * `noticeRetryDelayMs(1)`; its cap slot was spent at claim time. If this call
   * never arrives, the alarm recovers the claim at its `due_ms`.
   */
  async settleClaim(kind: AccountNoticeKind, atMs: number, result: NoticeSendResult, nowMs: number): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const claimed = takeClaimed(this.sql, kind, atMs);
      if (claimed !== null && result === "transient") {
        mergePending(this.sql, { ...claimed, attempts: 1, dueMs: nowMs + noticeRetryDelayMs(1) });
      }
    });
    await this.rearm();
  }

  /** Clears the device list only; the epoch and the notice tables are untouched (§4.1). */
  async forgetDevices(): Promise<void> {
    this.sql.exec("DELETE FROM known_devices");
    await this.rearm();
  }

  /** Both reapers call this: every pending (or in-flight) notice ends `dropped_account_gone`, logged (§4.5). */
  async dropPendingNotices(): Promise<void> {
    for (const table of ["pending_notice", "inflight_notice", "claimed_notice"] as const) {
      for (const p of allPending(this.sql, table)) {
        this.sql.exec(`DELETE FROM ${table} WHERE kind = ? AND last_event_ms = ?`, p.kind, p.lastEventMs);
        logNoticeEnd("dropped_account_gone", p.kind);
      }
    }
    await this.rearm();
  }

  async alarm(): Promise<void> {
    await this.alarmAt(Date.now());
  }

  /** Prune expired browsers and send times, send what is due, re-arm (§4.1, §4.4). */
  async alarmAt(nowMs: number): Promise<void> {
    this.sql.exec("DELETE FROM known_devices WHERE last_seen <= ?", nowMs - DEVICE_TTL_MS);
    this.sql.exec("DELETE FROM notices WHERE sent_ms <= ?", nowMs - DAY_MS);
    // A send interrupted by an eviction left its row in flight, and a route cut
    // off after its claim left a claimed row past its timeout (R2-3): both are
    // pending again, and go out in this run.
    this.ctx.storage.transactionSync(() => {
      for (const p of allPending(this.sql, "inflight_notice")) {
        this.sql.exec("DELETE FROM inflight_notice WHERE kind = ?", p.kind);
        mergePending(this.sql, p);
      }
      for (const p of allPending(this.sql, "claimed_notice")) {
        if (p.dueMs > nowMs) continue;
        this.sql.exec("DELETE FROM claimed_notice WHERE kind = ? AND last_event_ms = ?", p.kind, p.lastEventMs);
        mergePending(this.sql, { ...p, dueMs: nowMs, attempts: Math.max(p.attempts, 1) });
      }
    });
    for (const p of allPending(this.sql)) {
      if (p.dueMs <= nowMs) await this.sendPending(p.kind, nowMs);
    }
    await this.rearm();
  }

  private async sendPending(kind: AccountNoticeKind, nowMs: number): Promise<void> {
    // Detach BEFORE the await (audit I-2): a sign-in folded while Postmark is
    // answering lands in a fresh pending row, which settle never touches.
    const p = this.ctx.storage.transactionSync(() => detachPending(this.sql, kind));
    if (p === null) return;
    const userId = this.owner();
    if (userId === null) {
      // Audit I-9: its own outcome, never "account gone". Retried until the
      // owner is known or the notice's maximum age passes.
      console.warn(`account-notice: owner_unknown ${kind}`);
      await this.settle(p, "transient", nowMs);
      return;
    }
    const facts: NoticeFacts = {
      kind: p.kind,
      atMs: p.lastEventMs,
      country: p.lastCountry,
      coalesced: p.count > 1 ? { count: p.count - 1, sinceMs: p.firstEventMs } : null,
      listWasEmpty: p.listWasEmpty,
    };
    let result: NoticeSendResult;
    try {
      result = await this.noticeSender(this.env, { waitUntil: (x) => this.ctx.waitUntil(x) }, userId, facts);
    } catch {
      result = "transient";
    }
    await this.settle(p, result, nowMs);
  }

  /** The named end states (§4.4 G1). Only the detached in-flight row is settled; pending folds are untouched. */
  private async settle(p: PendingNotice, result: NoticeSendResult, nowMs: number): Promise<void> {
    const retry = result === "transient" && nowMs - p.firstEventMs < NOTICE_MAX_AGE_MS;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM inflight_notice WHERE kind = ?", p.kind);
      if (retry) mergePending(this.sql, { ...p, attempts: p.attempts + 1, dueMs: nowMs + noticeRetryDelayMs(p.attempts + 1) });
      if (result === "sent") this.sql.exec("INSERT INTO notices (kind, sent_ms) VALUES (?, ?)", p.kind, nowMs);
    });
    if (retry || result === "sent") return;
    if (result === "gone") {
      logNoticeEnd("dropped_account_gone", p.kind);
      return;
    }
    const state = result === "permanent" ? "dropped_permanent_refusal" : "dropped_expired";
    logNoticeEnd(state, p.kind);
    try {
      await this.ledgerFor().noticeDropped(state);
    } catch {
      // The log line above stands; the ledger is not this object's to retry.
    }
  }

  /** The earliest of: the oldest browser's expiry, the oldest send time's expiry, the next due notice. */
  private async rearm(): Promise<void> {
    const next = this.sql
      .exec<{ t: number | null }>(
        `SELECT MIN(t) AS t FROM (
           SELECT MIN(last_seen) + ? AS t FROM known_devices
           UNION ALL SELECT MIN(sent_ms) + ? FROM notices
           UNION ALL SELECT MIN(due_ms) FROM pending_notice
           UNION ALL SELECT MIN(due_ms) FROM inflight_notice
           UNION ALL SELECT MIN(due_ms) FROM claimed_notice)`,
        DEVICE_TTL_MS,
        DAY_MS,
      )
      .one().t;
    await this.armAt(next);
  }
}
```

- [ ] **Step 3: GREEN** with Task 19. `test/user-security-do.test.ts` (the epoch) must stay green unchanged.

### Task 18: Ledger additions — notice drops and the config fault

**Files:** modify `apps/api/src/durable-objects/SecurityLedgerDO.ts`, `apps/api/test/security-ledger-do.test.ts`.

**Produces:** RPC `noticeDropped(endState)`; test entry point `noticeDroppedAt`; seam `deviceKeyPresent`; alarm step 6: one `config_fault` per UTC day while `DEVICE_HASH_KEY` is absent, whatever `ACCOUNT_NOTICES_ENABLED` says (P-14, R2-2), tested with notices off.

- [ ] **Step 1: RED.** Append to the test file:

```ts
/** PR 2: config fault and notice drops. */
describe("PR 2 additions", () => {
  it("R2-2: NOTICES OFF and no DEVICE_HASH_KEY → exactly one config_fault that day (control: key present → none)", async () => {
    expect(env.ACCOUNT_NOTICES_ENABLED).toBe("0"); // the flag as shipped
    for (const keyPresent of [false, true]) {
      await runInDurableObject(freshLedger(), async (ledger) => {
        const { sink, sent } = capturingSink();
        ledger.sinkFactory = () => sink;
        ledger.siteFor = () => noSite;
        ledger.deviceKeyPresent = () => keyPresent;
        quiet(ledger);
        for (const at of [T0, T0 + 1, T0 + HOUR, T0 + HOUR + 1]) await ledger.alarmAt(at);
        expect(ofType(sent, "config_fault"), String(keyPresent)).toHaveLength(keyPresent ? 0 : 1);
      });
    }
  });

  it("one notice_dropped per drop state per UTC day; the rest are counted in the digest", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      const { sink, sent } = capturingSink();
      ledger.sinkFactory = () => sink;
      ledger.siteFor = () => noSite;
      quiet(ledger);
      for (let i = 0; i < 3; i++) await ledger.noticeDroppedAt("dropped_expired", T0 + i);
      await ledger.noticeDroppedAt("dropped_permanent_refusal", T0 + 5);
      await ledger.alarmAt(T0 + 10);
      await ledger.alarmAt(T0 + 11);
      expect(ofType(sent, "notice_dropped").map((m) => m.endState).sort()).toEqual(["dropped_expired", "dropped_permanent_refusal"]);
      expect(ofType(sent, "digest")[0]?.noticesDropped).toEqual({ dropped_permanent_refusal: 1, dropped_expired: 3 });
    });
  });
});
```

- [ ] **Step 2: Implement.**

```diff
--- a/apps/api/src/durable-objects/SecurityLedgerDO.ts
+++ b/apps/api/src/durable-objects/SecurityLedgerDO.ts
@@ -22,6 +22,7 @@
   HELD_ROW_CAP,
   LogSecurityAlertSink,
   logSecurityEvent,
+  resolveDeviceKeys,
   selectSecurityAlertSink,
   type CounterReport,
   type LedgerReportBatch,
@@ -80,6 +81,8 @@
    * the cron's `ensureLedgerAlarm`.
    */
   armAt: (ms: number) => Promise<void> = (ms) => this.ctx.storage.setAlarm(ms);
+  /** TEST SEAM (PR 2): whether `DEVICE_HASH_KEY` is set, so a test can take it away without a new env. */
+  deviceKeyPresent: () => boolean = () => resolveDeviceKeys(this.env) !== null;
 
   constructor(ctx: DurableObjectState, env: Env) {
     super(ctx, env);
@@ -325,8 +328,20 @@
     });
   }
 
-  /** Step 6 (PR 2 fills this in): one `config_fault` per UTC day while the device key is absent. */
-  private configFault(_nowMs: number): void {}
+  /**
+   * Step 6 (N5; PM ruling R2-2): one `config_fault` per UTC day while the key is
+   * absent, WHATEVER `ACCOUNT_NOTICES_ENABLED` says — device recording runs from
+   * phase 1, and without the key it silently stops.
+   */
+  private configFault(nowMs: number): void {
+    if (this.deviceKeyPresent()) return;
+    const day = utcDay(nowMs);
+    this.ctx.storage.transactionSync(() => {
+      if (this.store.meta("config_fault_day") === day) return;
+      this.store.queue({ type: "config_fault", key: "DEVICE_HASH_KEY", detail: "missing" }, nowMs);
+      this.store.setMeta("config_fault_day", day);
+    });
+  }
 
   private isForgotten(userId: string, nowMs: number): boolean {
     return this.store.count("SELECT COUNT(*) AS n FROM forgotten WHERE user_id = ? AND until_ms > ?", userId, nowMs) > 0;
@@ -376,6 +391,22 @@
     });
   }
 
+  /** RPC from `UserSecurityDO` (§4.4): one `notice_dropped` per drop state per UTC day; the rest counted. */
+  async noticeDropped(endState: SecurityNoticeDropped["endState"]): Promise<void> {
+    await this.noticeDroppedAt(endState, Date.now());
+  }
+
+  async noticeDroppedAt(endState: SecurityNoticeDropped["endState"], nowMs: number): Promise<void> {
+    const day = utcDay(nowMs);
+    this.ctx.storage.transactionSync(() => {
+      const store = this.store;
+      const countToday = store.addMeta(`notice_dropped:${endState}:${day}`, 1);
+      store.addMeta(`notices_dropped:${endState}`, 1);
+      if (countToday === 1) store.queue({ type: "notice_dropped", endState, day, countToday }, nowMs);
+    });
+    await this.ensureAlarm();
+  }
+
   /** Prune work left → now; otherwise the next due outbox row or the next hour, whichever is sooner. */
   private async rearm(nowMs: number, pruneRemaining: boolean): Promise<void> {
     if (pruneRemaining) {
```

- [ ] **Step 3: GREEN.** `…/api test -- test/security-ledger-do.test.ts`. Mutation control (executed): restore the notices-flag condition in `configFault` — the R2-2 test goes RED; restore.

### Task 19: The sign-in and reset flows, wired into login, signup and reset

**Files:** create `apps/api/src/security/account-notices-flow.ts`, `apps/api/test/account-notices.test.ts`; modify `apps/api/src/routes/login.ts`, `apps/api/src/routes/signup.ts`, `apps/api/src/routes/reset-password.ts`.

**Produces:** `afterSignIn(env, ctx, mode: "login" | "signup", s: SignInFacts, random?)`, `afterPasswordReset(env, ctx, s)` (§4.1 "The flow on login", "Reset"). Each runs in one `ctx.waitUntil` after the response is decided; never on a failed login; never throws. Login mints the device cookie on any success without a well-formed one; signup records silently; a non-barred reset records its browser after clearing the others; a **barred** reset mints no cookie, calls `forgetDevices()` and still sends the reset notice (`test/barred-reentry.test.ts:113-121` pins its 200 with no `Set-Cookie`). ⚠️ **CR-1, R2-3:** a send-now claim is already on disk (`claimed_notice`) before the route sends; any throw from the send — the address lookup included — becomes "transient", and `settleClaim` folds the claim back into `retrying`. If the route is cut off before it settles, the alarm sends the claim at its due time (tested by skipping the send).

- [ ] **Step 1: RED.** (Every claim a test makes goes through `quietClaim`, inside the object with `armAt` replaced, I-5.)

```ts
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEVICE_TTL_MS, NOTICE_MAX_AGE_MS, deviceHash, keyId } from "@thinkersjournal/shared";

import worker from "../src";
import { hashPassword } from "../src/auth/password";
import { withClient } from "../src/db/client";
import { sendNotice } from "../src/security/account-notice-send";
import { afterPasswordReset, afterSignIn } from "../src/security/account-notices-flow";

/**
 * Account-holder notices (security-alerting spec §4). Pool
 * project. Postmark is intercepted the way test/forgot-password.test.ts does it
 * (`vi.stubGlobal("fetch")`); the stub reaches `UserSecurityDO` too, because the
 * pool runs the Durable Objects in the test's isolate.
 */
const ORIGIN = "https://community.thinkersjournal.com";
const PASSWORD = "correct-horse-battery-staple";
const ON = { ...env, ACCOUNT_NOTICES_ENABLED: "1" } as Env;
const DAY = 86_400_000;
const created: string[] = [];

interface Mail {
  to: string;
  subject: string;
  text: string;
}
let mails: Mail[] = [];
let postmarkStatus: { status: number; body: unknown } = { status: 200, body: { ErrorCode: 0 } };

beforeEach(() => {
  mails = [];
  postmarkStatus = { status: 200, body: { ErrorCode: 0 } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.postmarkapp.com/")) throw new Error(`unexpected fetch to ${url}`);
      const b = JSON.parse(String(init?.body)) as { To: string; Subject: string; TextBody: string };
      if (postmarkStatus.status === 200) mails.push({ to: b.To, subject: b.Subject, text: b.TextBody });
      return new Response(JSON.stringify(postmarkStatus.body), { status: postmarkStatus.status });
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("DELETE FROM users WHERE email = ANY($1)", [created.splice(0)]));
  await waitOnExecutionContext(ctx);
});

async function newUser(): Promise<{ email: string; id: string }> {
  const email = `notice_${crypto.randomUUID()}@example.test`;
  created.push(email);
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, await hashPassword(PASSWORD)],
    );
    return rows[0]?.id ?? "";
  });
  await waitOnExecutionContext(ctx);
  return { email, id };
}

/** POST /auth/login; returns the response and the device token it carried or minted. */
async function login(email: string, token: string | null, e: Env = ON, ip = "203.0.113.10") {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    Origin: ORIGIN,
    "X-TJ-Client-Country": "DE",
    "CF-Connecting-IP": ip,
  };
  if (token !== null) headers.Cookie = `tj_device_dev=${token}`;
  const res = await worker.fetch(
    new Request("https://api.test/auth/login", { method: "POST", headers, body: JSON.stringify({ email, password: PASSWORD }) }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const minted = res.headers.getSetCookie().find((c) => c.startsWith("tj_device_dev="));
  return { res, token: minted === undefined ? token : (minted.split(";")[0] ?? "").slice("tj_device_dev=".length) };
}

/** Run a flow inside its own execution context, the way a route's waitUntil would. */
async function flow(run: (ctx: ExecutionContext) => Promise<void>): Promise<void> {
  const ctx = createExecutionContext();
  await run(ctx);
  await waitOnExecutionContext(ctx);
}

const tokenOf = (c: string) => c.padEnd(43, c).slice(0, 43);

/**
 * Claim inside the object with its alarm seam replaced (audit I-5): a claim made
 * through the production stub arms a REAL alarm for about now, which would race
 * the test's explicit clock.
 */
async function quietClaim(userId: string, atMs: number, notBeforeMs: number, country: string | null = null, listWasEmpty = false) {
  await runInDurableObject(env.USER_SECURITY.getByName(userId), async (u) => {
    u.armAt = async () => undefined;
    await u.claimNotice("new_sign_in", { atMs, country, listWasEmpty }, atMs, notBeforeMs);
  });
}

async function pendingRows(userId: string) {
  return runInDurableObject(env.USER_SECURITY.getByName(userId), (_u, s) =>
    s.storage.sql.exec<{ count: number; due_ms: number; attempts: number }>("SELECT count, due_ms, attempts FROM pending_notice").toArray(),
  );
}

/** A Hyperdrive binding whose connect always fails: the address lookup THROWS (CR-1). */
const DEAD_DB = { ...ON, HYPERDRIVE_FRESH: { ...env.HYPERDRIVE_FRESH, connectionString: "postgres://x:y@127.0.0.1:1/none" } } as Env;

async function deviceCount(userId: string): Promise<number> {
  return runInDurableObject(env.USER_SECURITY.getByName(userId), (_u, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM known_devices").one().n,
  );
}

describe("when notices fire (§4.1)", () => {
  it("signup is silent, and records its browser", async () => {
    const { id } = await newUser();
    await flow((ctx) => afterSignIn(ON, ctx, "signup", { userId: id, token: tokenOf("S"), country: null, nowMs: Date.now() }));
    expect(mails).toHaveLength(0);
    expect(await deviceCount(id)).toBe(1);
  });

  it("rollout: an empty list → the first login mails, with the 'no browser on record' sentence", async () => {
    const { email } = await newUser();
    const first = await login(email, null);
    expect(first.res.status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.text).toContain("had no browser on record");
    expect(mails[0]?.text).toContain("Germany");
    expect(mails[0]?.text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("a new browser mails once, without that sentence; the known one does not (control)", async () => {
    const { email } = await newUser();
    const a = await login(email, null);
    mails = [];
    await login(email, a.token);
    expect(mails).toHaveLength(0);
    await login(email, null);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.text).not.toContain("had no browser on record");
  });

  it("expiry: a browser last seen 401 days ago is pruned by the alarm, and its next login mails", async () => {
    const { email, id } = await newUser();
    const a = await login(email, null);
    const stub = env.USER_SECURITY.getByName(id);
    await runInDurableObject(stub, async (u, state) => {
      u.armAt = async () => undefined;
      state.storage.sql.exec("UPDATE known_devices SET last_seen = ?", Date.now() - DEVICE_TTL_MS - DAY);
      await u.alarmAt(Date.now());
    });
    mails = [];
    await login(email, a.token);
    expect(mails).toHaveLength(1);
  });

  it("re-signup clears: claimant A's browser is gone after B's signup, so A's cookie mails", async () => {
    const { email, id } = await newUser();
    await flow((ctx) => afterSignIn(ON, ctx, "signup", { userId: id, token: tokenOf("A"), country: null, nowMs: Date.now() }));
    await flow((ctx) => afterSignIn(ON, ctx, "signup", { userId: id, token: tokenOf("B"), country: null, nowMs: Date.now() }));
    await login(email, tokenOf("A"));
    expect(mails).toHaveLength(1);
  });

  it("a reset clears every browser but the resetting one; it mails 'password was changed'", async () => {
    const { email, id } = await newUser();
    await login(email, tokenOf("A"));
    await login(email, tokenOf("B"));
    mails = [];
    await flow((ctx) => afterPasswordReset(ON, ctx, { userId: id, token: tokenOf("C"), country: null, nowMs: Date.now() }));
    expect(mails.map((m) => m.subject)).toEqual(["Your Thinkers Journal password was changed"]);
    expect(await deviceCount(id)).toBe(1);
    mails = [];
    await login(email, tokenOf("A"));
    expect(mails).toHaveLength(1);
  });

  it("a barred reset (no token) forgets every browser and still mails", async () => {
    const { email, id } = await newUser();
    await login(email, tokenOf("A"));
    mails = [];
    await flow((ctx) => afterPasswordReset(ON, ctx, { userId: id, token: null, country: null, nowMs: Date.now() }));
    expect(mails).toHaveLength(1);
    expect(await deviceCount(id)).toBe(0);
  });
});

describe("device keys (N5)", () => {
  it("rotation with _PREV: no mail, the entry is rewritten to K2; after _PREV goes, still no mail", async () => {
    const { email, id } = await newUser();
    const k1 = { ...ON, DEVICE_HASH_KEY: "K1" } as Env;
    const both = { ...ON, DEVICE_HASH_KEY: "K2", DEVICE_HASH_KEY_PREV: "K1" } as Env;
    const k2 = { ...ON, DEVICE_HASH_KEY: "K2" } as Env;
    const a = await login(email, null, k1);
    const stale = await login(email, null, k1); // a second browser that will sit the rotation out
    mails = [];
    await login(email, a.token, both);
    expect(mails).toHaveLength(0);
    expect(
      await runInDurableObject(env.USER_SECURITY.getByName(id), async (_u, s) =>
        s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM known_devices WHERE kid = ?", await keyId("K2")).one().n,
      ),
    ).toBe(1);
    await login(email, a.token, k2);
    expect(mails).toHaveLength(0);
    await login(email, stale.token, k2); // control: unused during the rotation → mails
    expect(mails).toHaveLength(1);
  });

  it("no key: logins send nothing, record nothing and log NOTHING per login (I-3); a reset still mails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { email, id } = await newUser();
    const noKey = { ...ON, DEVICE_HASH_KEY: "" } as Env;
    await login(email, null, noKey);
    await login(email, null, noKey);
    expect(mails).toHaveLength(0);
    expect(await deviceCount(id)).toBe(0);
    // The operator hears through the ledger's ONE config_fault a day (test/security-ledger-do.test.ts).
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("device_hash_key_missing"))).toEqual([]);
    await flow((ctx) => afterPasswordReset(noKey, ctx, { userId: id, token: tokenOf("R"), country: null, nowMs: Date.now() }));
    expect(mails).toHaveLength(1);
  });

  it("HMAC: one token under two user ids → two different stored hashes, neither the plain SHA-256", async () => {
    expect(await deviceHash("K", "u1", tokenOf("T"))).not.toBe(await deviceHash("K", "u2", tokenOf("T")));
  });
});

describe("caps, deferral and end states (§4.4)", () => {
  it("cap: after one known login, four new browsers in an hour → three mails; the 4th is deferred, and says 'also covers'", async () => {
    const { email, id } = await newUser();
    await login(email, null);
    mails = [];
    for (let i = 0; i < 4; i++) await login(email, null);
    expect(mails).toHaveLength(2); // the first login's own mail used one of the three slots
    const due = await runInDurableObject(env.USER_SECURITY.getByName(id), (_u, s) =>
      s.storage.sql.exec<{ due_ms: number; count: number }>("SELECT due_ms, count FROM pending_notice").one(),
    );
    expect(due.count).toBe(2);
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u) => {
      u.armAt = async () => undefined;
      await u.alarmAt(due.due_ms);
    });
    expect(mails.at(-1)?.text).toContain("also covers 1 other new sign-in since");
  });

  it("TAKEOVER UNDER SATURATION (F1): 50 other accounts' sign-ins never change when or whether the victim is told", { timeout: 180_000 }, async () => {
    const victim = await newUser();
    for (let i = 0; i < 3; i++) await login(victim.email, null); // the victim's own cap: 3 in the hour
    const attackers = await Promise.all(Array.from({ length: 50 }, () => newUser()));
    const pending = () =>
      runInDurableObject(env.USER_SECURITY.getByName(victim.id), (_u, s) =>
        s.storage.sql.exec<{ due_ms: number; count: number }>("SELECT due_ms, count FROM pending_notice").toArray(),
      );
    mails = [];
    await login(victim.email, null, ON, "198.51.100.200"); // the takeover sign-in, over the cap → deferred
    await login(victim.email, null, ON, "198.51.100.201");
    const before = await pending();
    expect(before).toHaveLength(1);
    expect(before[0]?.count).toBe(2);
    for (const [i, a] of attackers.entries()) await login(a.email, null, ON, `192.0.2.${i}`);
    expect(await pending()).toEqual(before); // no other account's traffic moved it
    expect(mails.filter((m) => m.to === victim.email)).toHaveLength(0);
    await runInDurableObject(env.USER_SECURITY.getByName(victim.id), async (u) => {
      u.armAt = async () => undefined;
      await u.alarmAt(before[0]?.due_ms ?? 0);
    });
    const told = mails.filter((m) => m.to === victim.email);
    expect(told).toHaveLength(1);
    expect(told[0]?.text).toContain("also covers 1 other new sign-in since");
  });

  it("flag off: no Postmark call, one would_send line, and the cap is not consumed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { email, id } = await newUser();
    await login(email, null, env);
    expect(mails).toHaveLength(0);
    expect(warn.mock.calls.filter((c) => c[0] === "account-notice: would_send new_sign_in")).toHaveLength(1);
    const sent = await runInDurableObject(env.USER_SECURITY.getByName(id), (_u, s) =>
      s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM notices").one().n,
    );
    expect(sent).toBe(0);
  });

  it("ErrorCode 406 on a deferred notice → dropped_permanent_refusal at once, logged, one notice_dropped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { id } = await newUser();
    const stub = env.USER_SECURITY.getByName(id);
    const now = Date.now();
    await quietClaim(id, now, now + 60_000);
    postmarkStatus = { status: 422, body: { ErrorCode: 406 } };
    const dropped: string[] = [];
    await runInDurableObject(stub, async (u, s) => {
      u.armAt = async () => undefined;
      u.ledgerFor = () => ({ noticeDropped: async (state) => void dropped.push(state) });
      await u.alarmAt(now + 60_000);
      expect(s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_notice").one().n).toBe(0);
    });
    expect(dropped).toEqual(["dropped_permanent_refusal"]);
    expect(warn.mock.calls.some((c) => c[0] === "account-notice: dropped dropped_permanent_refusal new_sign_in")).toBe(true);
  });

  it("transient refusals (HTTP 503) retry at 15, 30, 60 min … then drop as expired after 7 days", async () => {
    const { id } = await newUser();
    const stub = env.USER_SECURITY.getByName(id);
    const t0 = Date.now();
    await quietClaim(id, t0, t0 + 1);
    postmarkStatus = { status: 503, body: {} };
    const dropped: string[] = [];
    await runInDurableObject(stub, async (u, s) => {
      u.armAt = async () => undefined;
      u.ledgerFor = () => ({ noticeDropped: async (state) => void dropped.push(state) });
      const delays: number[] = [];
      let at = t0 + 1;
      for (let i = 0; i < 3; i++) {
        await u.alarmAt(at);
        const next = s.storage.sql.exec<{ due_ms: number }>("SELECT due_ms FROM pending_notice").one().due_ms;
        delays.push((next - at) / 60_000);
        at = next;
      }
      expect(delays).toEqual([15, 30, 60]);
      await u.alarmAt(t0 + NOTICE_MAX_AGE_MS);
    });
    expect(dropped).toEqual(["dropped_expired"]);
  });

  it("a pending notice for an account that is gone → dropped_account_gone, no Postmark call, no alert", async () => {
    const { id } = await newUser();
    const stub = env.USER_SECURITY.getByName(id);
    const now = Date.now();
    await quietClaim(id, now, now + 1);
    await runInDurableObject(stub, async (u) => {
      u.armAt = async () => undefined;
      await u.dropPendingNotices();
    });
    expect(mails).toHaveLength(0);
    expect(
      await runInDurableObject(stub, (_u, s) => s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_notice").one().n),
    ).toBe(0);
  });

  it("CR-1: the address lookup THROWS on an immediate send → the notice and its folded sign-in stay, retrying", async () => {
    const { id } = await newUser();
    const now = Date.now();
    await quietClaim(id, now - 60_000, now + 3_600_000); // an earlier sign-in, deferred
    await flow((ctx) => afterSignIn(DEAD_DB, ctx, "login", { userId: id, token: tokenOf("Z"), country: null, nowMs: now }));
    expect(mails).toHaveLength(0);
    const rows = await pendingRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2); // the folded sign-in AND this one
    expect(rows[0]?.attempts).toBe(1);
  });

  it("R2-3: a route cut off right after its send-now claim → the claim (and its fold) is still sent by the alarm", async () => {
    const { email, id } = await newUser();
    const now = Date.now();
    await quietClaim(id, now - 60_000, now + 3_600_000); // an earlier sign-in, deferred
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
      u.armAt = async () => undefined;
      const claim = await u.claimNotice("new_sign_in", { atMs: now, country: "DE", listWasEmpty: false }, now, now);
      expect(claim.send).toBe("now");
      // … and the route is cut off here: no send, no settleClaim.
      expect(s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM claimed_notice").one().n).toBe(1);
      await u.alarmAt(now + 14 * 60_000); // before its timeout: left alone
      expect(mails).toHaveLength(0);
      await u.alarmAt(now + 15 * 60_000); // past it: recovered and sent
      expect(s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM claimed_notice").one().n).toBe(0);
    });
    expect(mails.map((m) => m.to)).toEqual([email]);
    expect(mails[0]?.text).toContain("also covers 1 other new sign-in since");
  });

  it("I-2: a sign-in folded WHILE the alarm awaits Postmark is neither deleted (sent) nor overwritten (retry)", async () => {
    for (const outcome of ["sent", "transient"] as const) {
      const { id } = await newUser();
      const t0 = Date.now();
      await quietClaim(id, t0, t0 + 1);
      await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
        u.armAt = async () => undefined;
        u.noticeSender = async () => {
          // The input gate is open during the real send's awaits: a new sign-in folds now.
          await u.claimNotice("new_sign_in", { atMs: t0 + 5, country: "FR", listWasEmpty: false }, t0 + 5, t0 + 3_600_000);
          return outcome;
        };
        await u.alarmAt(t0 + 1);
        const rows = s.storage.sql.exec<{ count: number; last_country: string | null }>("SELECT count, last_country FROM pending_notice").toArray();
        expect(rows.map((r) => r.count), outcome).toEqual([outcome === "sent" ? 1 : 2]);
        expect(rows[0]?.last_country, outcome).toBe("FR");
      });
    }
  });

  it("I-9: an unknown owner is its own outcome — logged owner_unknown, kept retrying, never 'account gone'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { id } = await newUser();
    const t0 = Date.now();
    await quietClaim(id, t0, t0 + 1);
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u, s) => {
      u.armAt = async () => undefined;
      s.storage.sql.exec("DELETE FROM owner");
      await u.alarmAt(t0 + 1);
      const rows = s.storage.sql.exec<{ attempts: number }>("SELECT attempts FROM pending_notice").toArray();
      expect(rows.map((r) => r.attempts)).toEqual([1]);
    });
    expect(warn.mock.calls.some((c) => c[0] === "account-notice: owner_unknown new_sign_in")).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("dropped_account_gone"))).toBe(false);
  });

  it("G2: a deferred notice reports its event's time and country, not the send time, and links CANONICAL_ORIGIN", async () => {
    const { id } = await newUser();
    const t = Date.parse("2026-10-07T03:04:05.000Z");
    await quietClaim(id, t, t + 2 * 3_600_000, null, true);
    await quietClaim(id, t + 60_000, t + 5 * 3_600_000, "DE", false); // the takeover, folded: due keeps the earlier time
    const [row] = await pendingRows(id);
    expect(row?.due_ms).toBe(t + 2 * 3_600_000);
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u) => {
      u.armAt = async () => undefined;
      await u.alarmAt(t + 2 * 3_600_000);
    });
    const text = mails[0]?.text ?? "";
    expect(text).toContain(new Date(t + 60_000).toISOString()); // the LAST event's time
    expect(text).toContain("from Germany (approximate)"); // and its country
    expect(text).not.toContain(new Date(t + 2 * 3_600_000).toISOString()); // not the send time
    expect(text).toContain("also covers 1 other new sign-in since 2026-10-07T03:04:05.000Z");
    expect(text).toContain("had no browser on record"); // the folded empty-list event keeps the sentence
    expect(text).toContain("https://community.thinkersjournal.com/forgot-password");
  });

  it("anonymised: a direct send for an anonymised id mails nothing (control: the same call for a live id mails)", async () => {
    const live = await newUser();
    const gone = await newUser();
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("UPDATE users SET anonymised_at = now() WHERE id = $1", [gone.id]));
    const facts = { kind: "new_sign_in" as const, atMs: Date.now(), country: null, coalesced: null, listWasEmpty: false };
    expect(await sendNotice(ON, ctx, live.id, facts)).toBe("sent");
    expect(await sendNotice(ON, ctx, gone.id, facts)).toBe("gone");
    await waitOnExecutionContext(ctx);
    expect(mails.map((m) => m.to)).toEqual([live.email]);
  });

  it("a barred reset (forgetDevices) leaves pending sign-in notices alone", async () => {
    const { id } = await newUser();
    const now = Date.now();
    await quietClaim(id, now, now + 3_600_000);
    await flow((ctx) => afterPasswordReset(ON, ctx, { userId: id, token: null, country: null, nowMs: now }));
    expect((await pendingRows(id)).map((r) => r.count)).toEqual([1]);
  });

  it("wave spread: a key replaced WITHOUT _PREV → unknownKeysOnly; pending inside 6 h; the alarm sends it", async () => {
    const { email, id } = await newUser();
    const a = await login(email, null, { ...ON, DEVICE_HASH_KEY: "OLD" } as Env);
    mails = [];
    await login(email, a.token, { ...ON, DEVICE_HASH_KEY: "NEW" } as Env);
    expect(mails).toHaveLength(0);
    const due = await runInDurableObject(env.USER_SECURITY.getByName(id), (_u, s) =>
      s.storage.sql.exec<{ due_ms: number }>("SELECT due_ms FROM pending_notice").one().due_ms,
    );
    expect(due - Date.now()).toBeLessThanOrEqual(6 * 3_600_000);
    await runInDurableObject(env.USER_SECURITY.getByName(id), async (u) => {
      u.armAt = async () => undefined;
      await u.alarmAt(due);
    });
    expect(mails).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement.**

```ts
/**
 * What login, signup and a completed reset do AFTER their response is built,
 * inside one `ctx.waitUntil` (security-alerting spec §4.1 "The flow on login").
 * Never on a failed login, never on the response path, and never throws: every
 * failure is logged and the request it rides is already answered.
 *
 * There is no site-wide limiter anywhere in this flow (F1).
 */
import {
  deviceHashes,
  isNewSignIn,
  logSecurityEvent,
  noticeNotBefore,
  resolveDeviceKeys,
  type AccountNoticeKind,
} from "@thinkersjournal/shared";

import { logNoticeEnd } from "../durable-objects/UserSecurityDO";

import { sendNotice, type NoticeFacts, type NoticeSendResult } from "./account-notice-send";

import type { NoticeEvent } from "./user-devices";

type Ctx = Pick<ExecutionContext, "waitUntil">;

export interface SignInFacts {
  readonly userId: string;
  /** The browser's device token: the one it sent, or the one minted on this response. */
  readonly token: string;
  readonly country: string | null;
  readonly nowMs: number;
}

/** Login and signup. Signup records its browser silently: the ONE silent path (§4.1). */
export async function afterSignIn(
  env: Env,
  ctx: Ctx,
  mode: "login" | "signup",
  s: SignInFacts,
  random: () => number = Math.random,
): Promise<void> {
  try {
    // No key: device notices are disabled, silently (N5). PM ruling I-3: no log
    // line per sign-in; the operator hears through the ledger's ONE config_fault
    // a day (alarm step 6), and PR 2's deploy gate sets the key first.
    const keys = resolveDeviceKeys(env);
    if (keys === null) return;
    const stub = env.USER_SECURITY.getByName(s.userId);
    const record = await stub.recordDevice(await deviceHashes(keys, s.userId, s.token), s.nowMs, mode);
    if (mode === "signup" || !isNewSignIn(record)) return;
    const event = { atMs: s.nowMs, country: s.country, listWasEmpty: record.listWasEmpty };
    await notify(env, ctx, s.userId, "new_sign_in", event, noticeNotBefore(record, s.nowMs, random));
  } catch (err) {
    console.error("account-notice: sign-in follow-up failed", err instanceof Error ? err.name : "threw");
  }
}

/**
 * A completed reset, on BOTH 200 paths. `token` is null on the barred path,
 * which mints no device cookie and forgets every browser (§4.1 m4). The reset
 * notice does not depend on the key.
 */
export async function afterPasswordReset(
  env: Env,
  ctx: Ctx,
  s: Omit<SignInFacts, "token"> & { readonly token: string | null },
): Promise<void> {
  try {
    const stub = env.USER_SECURITY.getByName(s.userId);
    const keys = resolveDeviceKeys(env);
    if (s.token === null) await stub.forgetDevices();
    else if (keys !== null) await stub.recordDevice(await deviceHashes(keys, s.userId, s.token), s.nowMs, "reset");
    await notify(env, ctx, s.userId, "password_reset", { atMs: s.nowMs, country: s.country, listWasEmpty: false }, s.nowMs);
  } catch (err) {
    console.error("account-notice: reset follow-up failed", err instanceof Error ? err.name : "threw");
  }
}

/**
 * ⚠️ CR-1 (PM): once `claimNotice` answered "now", the notice (and every sign-in
 * folded into it) exists ONLY in this call. A throw anywhere in the send — the
 * address lookup's `client.connect()` included — must not drop it: it is
 * "transient", and the caller requeues it into `retrying`.
 */
async function sendOrTransient(env: Env, ctx: Ctx, userId: string, facts: NoticeFacts): Promise<NoticeSendResult> {
  try {
    return await sendNotice(env, ctx, userId, facts);
  } catch (err) {
    logSecurityEvent({ kind: "alerting_fault", route: "account-notice", reason: "notice_send_threw", ip: null });
    console.error("account-notice: send threw; requeued", err instanceof Error ? err.name : "threw");
    return "transient";
  }
}

/** Flag off: one log line, and nothing is claimed (§4.1 step 4). Otherwise claim, then send or leave it deferred. */
async function notify(
  env: Env,
  ctx: Ctx,
  userId: string,
  kind: AccountNoticeKind,
  event: NoticeEvent,
  notBeforeMs: number,
): Promise<void> {
  if (env.ACCOUNT_NOTICES_ENABLED !== "1") {
    console.warn(`account-notice: would_send ${kind}`);
    return;
  }
  const stub = env.USER_SECURITY.getByName(userId);
  const claim = await stub.claimNotice(kind, event, event.atMs, notBeforeMs);
  if (claim.send === "deferred") return; // UserSecurityDO's alarm sends it (§4.4)
  const facts: NoticeFacts = { kind, atMs: event.atMs, country: event.country, coalesced: claim.coalesced, listWasEmpty: event.listWasEmpty };
  const result = await sendOrTransient(env, ctx, userId, facts);
  // R2-3: the claim is already on disk; this clears it, or turns it into a retry
  // (P-5, CR-1). If this call is lost, the alarm recovers the claim.
  await stub.settleClaim(kind, event.atMs, result, Date.now());
  if (result === "gone") {
    logNoticeEnd("dropped_account_gone", kind);
  } else if (result === "permanent") {
    logNoticeEnd("dropped_permanent_refusal", kind);
    await env.SECURITY_LEDGER.getByName("ledger").noticeDropped("dropped_permanent_refusal");
  }
}
```

```diff
--- a/apps/api/src/routes/login.ts
+++ b/apps/api/src/routes/login.ts
@@ -93,6 +93,8 @@
 import { enforceRateLimit } from "../auth/ratelimit";
 import { createSession } from "../auth/session";
 import { withClient } from "../db/client";
+import { afterSignIn } from "../security/account-notices-flow";
+import { clientCountry, deviceCookieFor, sessionAndDeviceHeaders } from "../security/device-cookie";
 import { clientIp } from "../http/client-ip";
 import { errorResponse } from "../http/errors";
 
@@ -160,7 +162,9 @@
  * Every one is logged as a `security: auth_failure` line (packages/shared's
  * security-log.ts) with the SAME reason for both cases, so the log cannot become
  * the enumeration oracle the response refuses to be. Never the password, and
- * never the email: the alerting follow-up counts by IP and route.
+ * never the email IN THE LOG. `counting` (the address, and the account when one
+ * exists) goes to the in-process counter only, never to `console`
+ * (security-alerting spec §1.2, §2.2).
  */
 function unauthorized(ip: string | null, counting: SecurityEventCounting): Response {
   logSecurityEvent({ kind: "auth_failure", route: ROUTE, reason: "invalid_credentials", ip }, counting);
@@ -415,6 +419,18 @@
     createdAt: Date.now(),
   });
 
-  // ---- 10. 200 + Set-Cookie ------------------------------------------------
-  return json({ userId: row.id }, 200, { "Set-Cookie": cookie });
+  // ---- 10. Device record + new-sign-in notice (security-alerting §4.1) -------
+  // After the response is decided, in one waitUntil: never on the response path
+  // and never on a failed login. The response gains only a cookie read and, when
+  // the browser has no well-formed device cookie, a second Set-Cookie.
+  const device = deviceCookieFor(request, env);
+  ctx.waitUntil(
+    afterSignIn(env, ctx, "login", { userId: row.id, token: device.token, country: clientCountry(request), nowMs: Date.now() }),
+  );
+
+  // ---- 11. 200 + Set-Cookie ------------------------------------------------
+  return new Response(JSON.stringify({ userId: row.id }), {
+    status: 200,
+    headers: sessionAndDeviceHeaders(cookie, device, true),
+  });
 }
```

```diff
--- a/apps/api/src/routes/signup.ts
+++ b/apps/api/src/routes/signup.ts
@@ -59,6 +59,8 @@
 import { isUniqueViolation } from "../db/errors";
 import { clientIp } from "../http/client-ip";
 import { errorResponse } from "../http/errors";
+import { afterSignIn } from "../security/account-notices-flow";
+import { clientCountry, deviceCookieFor, sessionAndDeviceHeaders } from "../security/device-cookie";
 
 /**
  * The 403 returned for BOTH a failed Turnstile challenge and a rejected origin.
@@ -437,9 +439,18 @@
     createdAt: Date.now(),
   });
 
-  // ---- 9. 201 + Set-Cookie -------------------------------------------------
+  // ---- 9. Device record (security-alerting §4.1): the ONE silent path -----
+  // `recordDevice(…, "signup")` CLEARS the list and records this browser, so a
+  // re-signup of an unverified address leaves the earlier claimant's browsers
+  // nowhere. No notice.
+  const device = deviceCookieFor(request, env);
+  ctx.waitUntil(
+    afterSignIn(env, ctx, "signup", { userId, token: device.token, country: clientCountry(request), nowMs: Date.now() }),
+  );
+
+  // ---- 10. 201 + Set-Cookie ------------------------------------------------
   return new Response(JSON.stringify({ userId }), {
     status: 201,
-    headers: { "content-type": "application/json", "Set-Cookie": cookie },
+    headers: sessionAndDeviceHeaders(cookie, device, true),
   });
 }
```

```diff
--- a/apps/api/src/routes/reset-password.ts
+++ b/apps/api/src/routes/reset-password.ts
@@ -72,6 +72,8 @@
 import { BEGIN_BOUNDED_TX, withClient } from "../db/client";
 import { clientIp } from "../http/client-ip";
 import { errorResponse } from "../http/errors";
+import { afterPasswordReset } from "../security/account-notices-flow";
+import { clientCountry, deviceCookieFor, sessionAndDeviceHeaders } from "../security/device-cookie";
 
 import type { AccountStatusRow } from "../auth/account-status";
 
@@ -285,6 +287,8 @@
   // cookie is missing. The caller holds the address's own token, so that
   // absence tells them nothing about someone else.
   if (account !== null && isBarred(account)) {
+    // security-alerting §4.1 m4: no device cookie, every browser forgotten, the reset notice still sent.
+    ctx.waitUntil(afterPasswordReset(env, ctx, { userId, token: null, country: clientCountry(request), nowMs: Date.now() }));
     return new Response(null, { status: 200 });
   }
 
@@ -300,5 +304,10 @@
     createdAt: Date.now(),
   });
 
-  return new Response(null, { status: 200, headers: { "Set-Cookie": cookie } });
-}
+  // security-alerting §4.1: the reset clears every browser but this one, then records it.
+  const device = deviceCookieFor(request, env);
+  ctx.waitUntil(
+    afterPasswordReset(env, ctx, { userId, token: device.token, country: clientCountry(request), nowMs: Date.now() }),
+  );
+  return new Response(null, { status: 200, headers: sessionAndDeviceHeaders(cookie, device, false) });
+}
```

- [ ] **Step 3: GREEN.** `…/api test -- test/account-notices.test.ts test/login.test.ts test/login-barred.test.ts test/signup.test.ts test/reset-password.test.ts test/barred-reentry.test.ts test/forgot-password.test.ts`. Mutation controls (the first two and the last executed): (a) make `sendOrTransient`'s `try` rethrow (a `finally` instead of the `catch`) — CR-1's test goes RED; (b) make `settle` also delete `pending_notice` — the I-2 test goes RED; (c) make `recordDeviceSync`'s `reset` branch keep the old entries — "a reset clears every browser but the resetting one" goes RED; (d) remove the `notBeforeMs <= nowMs` condition in `claimNoticeSync` — "wave spread" goes RED; (e) drop `writeClaimed` from the send-now branch — "R2-3: a route cut off" goes RED; restore each.

### Task 20: The country header on the web side

**Files:** modify `apps/web/src/lib/client-ip-store.ts` and the five `API.fetch` call sites (`src/lib/api.ts`, `src/lib/admin-api.ts`, `src/pages/api/media-restricted.ts`, `src/pages/api/notifications-ws.ts`, `src/pages/api/posts-live.ts`); create `apps/web/test/client-country.test.ts`.

- [ ] **Step 0: Implementer confirmation 5 (header half).** Under `wrangler dev`, log which of `request.cf?.country` or `CF-IPCountry` reaches `middleware.ts`. `edgeCountry` reads both, in that order.
- [ ] **Step 1: RED.**

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CLIENT_COUNTRY_HEADER } from "@thinkersjournal/shared";

import { applyClientCountryHeader, clientIpStore, edgeCountry, runWithClientIp } from "../src/lib/client-ip-store";

/**
 * `X-TJ-Client-Country` (security-alerting spec §4.2): the same
 * overwrite, delete and enumeration cases as test/client-ip-store.test.ts has
 * for the IP header.
 */
describe("edgeCountry / runWithClientIp", () => {
  it("seeds the store with the edge's country for the life of `next`", () => {
    const request = new Request("https://x.test/", { headers: { "CF-IPCountry": "DE", "CF-Connecting-IP": "203.0.113.9" } });
    expect(runWithClientIp(request, () => clientIpStore.getStore()?.clientCountry)).toBe("DE");
  });

  it.each([null, "de", "DEU", "203.0.113.9", "XX1"])("%j is not a country → null", (value) => {
    const headers: Record<string, string> = value === null ? {} : { "CF-IPCountry": value };
    expect(edgeCountry(new Request("https://x.test/", { headers }))).toBeNull();
  });
});

describe("applyClientCountryHeader", () => {
  it("sets the header", () => {
    const h = new Headers();
    applyClientCountryHeader(h, "FR");
    expect(h.get(CLIENT_COUNTRY_HEADER)).toBe("FR");
  });

  it("overrides a pre-existing value rather than leaving it", () => {
    const h = new Headers({ [CLIENT_COUNTRY_HEADER]: "ZZ" });
    applyClientCountryHeader(h, "FR");
    expect(h.get(CLIENT_COUNTRY_HEADER)).toBe("FR");
  });

  it("removes a pre-existing value when the country is null — never a stale or attacker value", () => {
    const h = new Headers({ [CLIENT_COUNTRY_HEADER]: "ZZ" });
    applyClientCountryHeader(h, null);
    expect(h.has(CLIENT_COUNTRY_HEADER)).toBe(false);
  });
});

describe("every API.fetch call site in apps/web/src applies applyClientCountryHeader", () => {
  // Enumerated from the INDEX (`git ls-files`), never by walking the disk: a disk
  // walk sees other checkouts' files (portfolio CLAUDE.md §5b).
  const ROOT = join(import.meta.dirname, "../../..");
  const sites = execFileSync("git", ["ls-files", "apps/web/src"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts") || f.endsWith(".astro"))
    .map((f) => join(ROOT, f))
    .filter((file) => /^\s*[^/*\s].*API\.fetch\(/m.test(readFileSync(file, "utf8")));

  it("finds the five real call sites (positive control)", () => {
    expect(sites.length).toBe(5);
  });

  it.each(sites)("%s applies the country header beside the IP header", (file) => {
    const code = readFileSync(file, "utf8");
    expect(code).toMatch(/applyClientCountryHeader\(\w+, clientIpStore\.getStore\(\)\?\.clientCountry \?\? null\)/);
  });
});
```

- [ ] **Step 2: Implement.**

```diff
--- a/apps/web/src/lib/client-ip-store.ts
+++ b/apps/web/src/lib/client-ip-store.ts
@@ -15,10 +15,26 @@
  */
 import { AsyncLocalStorage } from "node:async_hooks";
 
-import { CLIENT_IP_HEADER } from "@thinkersjournal/shared";
+import { CLIENT_COUNTRY_HEADER, CLIENT_IP_HEADER } from "@thinkersjournal/shared";
 
 export interface ClientIpStore {
   clientIp: string | null;
+  /** The edge's ISO 3166-1 alpha-2 country, or null (security-alerting spec §4.2). */
+  clientCountry: string | null;
+}
+
+const COUNTRY_RE = /^[A-Z]{2}$/;
+
+/**
+ * The edge's country for `request`: `request.cf.country` when the adapter
+ * passes the incoming request through, else the `CF-IPCountry` header. Which
+ * one reaches the middleware under @astrojs/cloudflare is implementer
+ * confirmation 5 (plan Task 16); a value that is not two capital letters is null.
+ */
+export function edgeCountry(request: Request): string | null {
+  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
+  const raw = typeof cf?.country === "string" ? cf.country : request.headers.get("CF-IPCountry");
+  return raw !== null && COUNTRY_RE.test(raw) ? raw : null;
 }
 
 export const clientIpStore = new AsyncLocalStorage<ClientIpStore>();
@@ -34,7 +50,7 @@
  */
 export function runWithClientIp<T>(request: Request, next: () => T): T {
   const clientIp = request.headers.get("CF-Connecting-IP");
-  return clientIpStore.run({ clientIp }, next);
+  return clientIpStore.run({ clientIp, clientCountry: edgeCountry(request) }, next);
 }
 
 /**
@@ -62,3 +78,16 @@
     headers.set(CLIENT_IP_HEADER, ip);
   }
 }
+
+/**
+ * Sets (or removes) `headers`' `CLIENT_COUNTRY_HEADER` to exactly `country`.
+ * The same delete-then-set discipline as `applyClientIpHeader`, and called
+ * beside it at every `API.fetch` call site (test/client-ip-store.test.ts
+ * enumerates them), always as `clientIpStore.getStore()?.clientCountry ?? null`.
+ */
+export function applyClientCountryHeader(headers: Headers, country: string | null): void {
+  headers.delete(CLIENT_COUNTRY_HEADER);
+  if (country !== null) {
+    headers.set(CLIENT_COUNTRY_HEADER, country);
+  }
+}
```

Each call site gains one line beside its `applyClientIpHeader` call; `api.ts` as the example (the other four are the same line on their own header variable — `headers`, `forwardHeaders`, `h`, `h`):

```diff
--- a/apps/web/src/lib/api.ts
+++ b/apps/web/src/lib/api.ts
@@ -43,7 +43,7 @@
 
 import { isApiErrorBody, type ApiErrorCode } from "@thinkersjournal/shared";
 
-import { applyClientIpHeader, clientIpStore } from "./client-ip-store";
+import { applyClientCountryHeader, applyClientIpHeader, clientIpStore } from "./client-ip-store";
 import { resolveOutgoingBody } from "./outgoing-body";
 
 /** What every call through this module returns. */
@@ -195,6 +195,7 @@
   // pre-existing value before (re)setting it, so nothing set above can
   // inject or override it.
   applyClientIpHeader(headers, clientIpStore.getStore()?.clientIp ?? null);
+  applyClientCountryHeader(headers, clientIpStore.getStore()?.clientCountry ?? null);
 
   // `body` (JSON) and `rawBody` (passthrough) are mutually exclusive; rawBody
   // wins if both are somehow set, and the type comment says not to. Pulled
```

- [ ] **Step 3: GREEN.** `pnpm --filter @thinkersjournal/web test -- test/client-country.test.ts test/client-ip-store.test.ts`.

### Task 21: The reapers forget browsers and pending notices too

**Files:** modify `apps/api/src/security/forget.ts`, `apps/api/test/anonymise-accounts.test.ts`, `apps/api/test/reap-unverified.test.ts`.

**Produces:** `forgetAccountEverywhere` gains `forgetDevices()` and `dropPendingNotices()` before the ledger step, each logged and continued on failure. Subrequests (m-g): 5 DO calls per anonymised account, 3 per reaped one; implementer confirmation 6 counts a real run.

- [ ] **Step 1: RED.** Append to `test/anonymise-accounts.test.ts`:

```ts
/** PR 2 (spec §4.5): the same hook also forgets the browsers and ends pending notices. */
describe("anonymiseExpiredAccounts — device clean-up", () => {
  it("clears the device list and drops pending notices (positive control: both present before)", async () => {
    const f = await seedAccount({ eligible: false });
    const stub = env.USER_SECURITY.getByName(f.id);
    const now = Date.now();
    await runInDurableObject(stub, async (u) => {
      u.armAt = async () => undefined;
      await u.recordDevice({ current: "a".repeat(64), currentKid: "kid00000", prev: null, prevKid: null }, now, "login");
      await u.claimNotice("new_sign_in", { atMs: now, country: null, listWasEmpty: false }, now, now + 3_600_000);
    });
    const counts = () =>
      runInDurableObject(stub, (_u, s) => [
        s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM known_devices").one().n,
        s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_notice").one().n,
      ]);
    expect(await counts()).toEqual([1, 1]);
    await withAnonymiseReaperLock(async () => {
      await makeEligible(f.id);
      const ctx = createExecutionContext();
      await anonymiseExpiredAccounts(env, ctx);
      await waitOnExecutionContext(ctx);
    });
    expect(await counts()).toEqual([0, 0]);
  });
});
```

and to `test/reap-unverified.test.ts`:

```ts
/** PR 2 (spec §4.5): the same per-id hook also forgets browsers and ends pending notices. */
describe("reapUnverifiedAccounts — device clean-up per deleted id", () => {
  it("a reaped account's browsers and pending notices are gone (control: a verified account keeps its own)", async () => {
    const gone = await seed({ verified: false, ageDays: 8 });
    const kept = await seed({ verified: true, ageDays: 8 });
    const now = Date.now();
    for (const f of [gone, kept]) {
      await runInDurableObject(env.USER_SECURITY.getByName(f.id), async (u) => {
        u.armAt = async () => undefined;
        await u.recordDevice({ current: "b".repeat(64), currentKid: "kid00000", prev: null, prevKid: null }, now, "signup");
        await u.claimNotice("password_reset", { atMs: now, country: null, listWasEmpty: false }, now, now + 3_600_000);
      });
    }
    const ctx = createExecutionContext();
    await reapUnverifiedAccounts(env, ctx);
    await waitOnExecutionContext(ctx);
    const count = (id: string) =>
      runInDurableObject(env.USER_SECURITY.getByName(id), (_u, s) => [
        s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM known_devices").one().n,
        s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_notice").one().n,
      ]);
    expect(await count(gone.id)).toEqual([0, 0]);
    expect(await count(kept.id)).toEqual([1, 1]);
  });
});
```

- [ ] **Step 2: Implement.**

```diff
--- a/apps/api/src/security/forget.ts
+++ b/apps/api/src/security/forget.ts
@@ -1,17 +1,21 @@
 /**
- * The reapers' security clean-up for one account (security-alerting spec §2.6
- * N7, m-e): forget it in the ledger, leaving a 30-day tombstone. PR 2 adds the
- * device-list and pending-notice steps beside this one.
+ * The reapers' security clean-up for one account (security-alerting spec §4.5,
+ * §2.6 m-e): forget its browsers, end its pending notices as
+ * `dropped_account_gone`, and forget it in the ledger (leaving a tombstone).
  *
- * Each call is logged and continued on failure — the same handling as the
- * anonymise reaper's post-scrub epoch bump. The backstop: the 7-day ref expiry.
+ * Three independent calls, each logged and continued on failure — the same
+ * handling as the anonymise reaper's post-scrub epoch bump. The backstops if
+ * one fails: the device alarm's 400-day pruning and the ledger's 7-day ref expiry.
  */
 export async function forgetAccountEverywhere(
-  env: Pick<Env, "SECURITY_LEDGER">,
+  env: Pick<Env, "USER_SECURITY" | "SECURITY_LEDGER">,
   userId: string,
   source: string,
 ): Promise<void> {
+  const user = env.USER_SECURITY.getByName(userId);
   const steps: readonly (readonly [string, () => Promise<void>])[] = [
+    ["forgetDevices", () => user.forgetDevices()],
+    ["dropPendingNotices", () => user.dropPendingNotices()],
     ["forgetAccount", () => env.SECURITY_LEDGER.getByName("ledger").forgetAccount(userId)],
   ];
   for (const [name, run] of steps) {
```

- [ ] **Step 3: GREEN.** `…/api test -- test/anonymise-accounts.test.ts test/reap-unverified.test.ts`.

### Task 22: The runbook: `DEVICE_HASH_KEY` setup and rotation (I-3, I-4)

**Files:** modify `docs/runbooks/deploy.md` — insert after Task 7's "Security alerting: the flags" section.

PM ruling, its intent verbatim: **"ALWAYS rotate DEVICE_HASH_KEY with _PREV".** Worker secrets are write-only (no read-back in wrangler or the dashboard), so the operator's own secret store is the only copy that makes rotation and restore possible. `wrangler secret put` reads an interactive value through a masked prompt (`prompt("Enter a secret value:", { isSecret: true })` in the installed wrangler 4.135.0's `wrangler-dist/cli.js`; re-check on the pinned 4.146.0), so the value never appears in a command line, shell history or log.

````md
## Security alerting: `DEVICE_HASH_KEY` (set BEFORE the PR that records browsers merges)

`DEVICE_HASH_KEY` is the `api` Worker secret that keys each account's list of
known browsers (HMAC-SHA-256, `deviceHash` in
`packages/shared/src/account-notices.ts`; security-alerting spec §4.1).

⚠️ **A Worker secret cannot be read back.** Keep the current value in your
password manager: rotation (below) and restoring a lost key both need it.

### Set it (once)

1. In your password manager, generate a random value of at least 32
   characters (its own generator; letters and digits are fine) and save it as
   "thinkersjournal-api DEVICE_HASH_KEY — current".
2. Run `npx wrangler secret put DEVICE_HASH_KEY --name thinkersjournal-api` and
   paste the value at the masked prompt. Never pass it as an argument, never
   pipe it from a command, and never paste it into a chat, an issue or a log.
3. Confirm it exists without revealing it:
   `npx wrangler secret list --name thinkersjournal-api` lists the NAME only.

Without it, device notices are DISABLED (no browser is recorded, no sign-in
notice is sent) with no log line per sign-in; the ledger sends one
`config_fault` a day while it is missing, whatever `ACCOUNT_NOTICES_ENABLED`
says. Reset notices do not depend on it.

### ⚠️ ALWAYS rotate `DEVICE_HASH_KEY` with `_PREV`

1. In the password manager, rename the current entry to "… DEVICE_HASH_KEY —
   previous", and generate a new "… — current".
2. `npx wrangler secret put DEVICE_HASH_KEY_PREV --name thinkersjournal-api`:
   paste the PREVIOUS value.
3. `npx wrangler secret put DEVICE_HASH_KEY --name thinkersjournal-api`: paste
   the NEW value. (Between steps 2 and 3 both secrets hold the old value, which
   is harmless.) Browsers that sign in are rewritten to the new key.
4. After 90 days, `npx wrangler secret delete DEVICE_HASH_KEY_PREV --name
   thinkersjournal-api`, and delete the "previous" entry. A browser unused for
   those 90 days then counts as new at its next sign-in and mails, like an
   expiry.

Replacing the key WITHOUT `_PREV` makes every account's next sign-in "new": a
wave of notices (spread over 6 hours, never dropped, but a wave). If the key is
ever lost from the Worker, restore the SAME value from the password manager:
that causes no wave.
````

### Task 23: PR 2 gate

- [ ] **Before the merge:** `DEVICE_HASH_KEY` is set in production by Task 22's procedure (`wrangler secret list` shows the name). The PR body says so.
- [ ] The four suites and `pnpm typecheck`, as in Task 14. `index.ts` gains no export in PR 2.
- [ ] **Deployed check (Review Focus 2):** on a preview deploy, sign in twice from one browser: the second sign-in must not set a new `__Host-tj_device`, and the browser's cookie store must hold it (`Secure`, `Path=/`, no `Domain`).
- [ ] Phase 1b stays gated (§6): D5 and Postmark delivery confirmed. This PR flips no flag.

---

# PR 3 — admin page, migration, health route, runbook (Tasks 24–29)

Branch from `main` after PR 2 merges. **The migration's number is `NNNN`, a placeholder: the PM allocates it when this PR opens.** Rename `NNNN_security_ref_resolved.sql` and every `NNNN` in this section before the first commit. (The scratch tree that verified this plan used `0026` as the stand-in, as the file name below shows.)

### Task 24: The `moderation_actions` constraint migration

**Files:** create `apps/api/migrations/NNNN_security_ref_resolved.sql`, `apps/api/test/security-ref-migration.db.test.ts`; modify `apps/api/src/moderation/actions.ts`.

- [ ] **Step 1: Re-run the readers grep (R3).** `grep -rn "FROM moderation_actions\|JOIN moderation_actions" apps/api/src` must print the 17 lines §2.6 lists (re-run at `f3da62d`: the same 17). Task 25's test pins the member-scoped half (`loadBarReason`, `loadAccountHistory`) on real rows.
- [ ] **Step 2: RED.** (The test refuses to pick a database if `TEST_DATABASE_URL` is unset, M-1.)

```ts
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration NNNN (security alerting): `moderation_actions` accepts
 * `security_ref_resolved` with no subject, and still refuses an unknown kind.
 * Node project, direct `pg`, against TEST_DATABASE_URL (the dedicated DB).
 */
// ⚠️ NO DEFAULT (audit M-1): run only with TEST_DATABASE_URL set to the dedicated
// test database (the plan's "Testing realities"), never the shared one.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
let client: Client;

beforeAll(async () => {
  if (TEST_DATABASE_URL === undefined) throw new Error("TEST_DATABASE_URL is not set: refusing to pick a database");
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe("moderation_actions accepts security_ref_resolved (spec §2.6 R4)", () => {
  it("inserts a row with the ref in internal_note and NO subject_user_id", async () => {
    const ref = "0123456789abcdef0123456789abcdef";
    const { rows } = await client.query<{ subject_user_id: string | null; internal_note: string }>(
      `INSERT INTO moderation_actions (actor_admin, action, reason, internal_note)
       VALUES ('admin@example.test', 'security_ref_resolved', 'Security alert reference looked up by an administrator', $1)
       RETURNING subject_user_id, internal_note`,
      [ref],
    );
    expect(rows[0]).toEqual({ subject_user_id: null, internal_note: ref });
  });

  it("still refuses an unknown kind (control: the constraint is live)", async () => {
    await expect(
      client.query(
        "INSERT INTO moderation_actions (actor_admin, action, reason) VALUES ('a@example.test', 'security_ref_resolvedX', 'r')",
      ),
    ).rejects.toThrow(/moderation_actions_action_check/);
  });
});
```

- [ ] **Step 3: Implement.** A strict superset of `0022:69-79`; no `-- deploy: after-code` marker (`scripts/lib/migration-gate.mjs:54`): it must run **before** the code that writes the kind.

```sql
-- Up Migration
-- Security alerting (docs/superpowers/specs/2026-10-07-security-alerting-design.md
-- §2.6 R4): an administrator's lookup of a security-alert account ref is
-- audited in the append-only moderation log. The row carries the admin's Access
-- identity and the REF (internal_note), and NEVER subject_user_id, so once the
-- ref expires (7 days) nothing links the two.
--
-- Additive: a strict superset of 0022's list (the latest; 0023-0025 did not
-- touch this constraint). It carries NO `-- deploy: after-code` marker: it must
-- be applied BEFORE the code that writes the new kind (docs/runbooks/deploy.md,
-- "Shipping a PR with an additive migration").
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide',
    'account_hold','account_hold_release',
    'security_ref_resolved'
  ));

-- Down Migration
-- Restores 0022's list. Fails while any security_ref_resolved row exists: the
-- table is append-only by trigger (0013), so such a row can never be removed,
-- and a down migration is never automated (docs/runbooks/deploy.md, Rollback).
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide',
    'account_hold','account_hold_release'
  ));
```

```diff
--- a/apps/api/src/moderation/actions.ts
+++ b/apps/api/src/moderation/actions.ts
@@ -23,7 +23,10 @@
   // author's own email here rather than an Access identity.
   | "author_hide" | "author_unhide"
   // Account legal holds (account-legal-hold spec §3 T3, migration 0022).
-  | "account_hold" | "account_hold_release";
+  | "account_hold" | "account_hold_release"
+  // Security alerting (spec §2.6 R4, migration NNNN): an admin resolved an alert's
+  // account ref. The row carries the ref and the admin, NEVER subject_user_id.
+  | "security_ref_resolved";
 
 export type ViolationCategory =
   | "spam" | "harassment" | "hate" | "sexual" | "violence" | "ip_infringement" | "other";
```

- [ ] **Step 4: GREEN.** `…/api test -- test/security-ref-migration.db.test.ts test/moderation-actions-schema.db.test.ts test/account-legal-holds-schema.db.test.ts`.

### Task 25: The ledger's admin reads, its admin link, and the two admin routes

**Files:** create `packages/shared/src/security-admin.ts`, `apps/api/src/security/ledger-admin.ts`, `apps/api/src/routes/admin-security.ts`, `apps/api/test/admin-security-route.test.ts`; modify `packages/shared/src/index.ts`, `apps/api/src/durable-objects/SecurityLedgerDO.ts`, `apps/api/src/routes.ts`, `apps/api/test/error-envelope.test.ts`.

**Produces:** `AdminSecurityRefResponse`, `AdminHeldRow`, `AdminSecurityHeldResponse`, `ADMIN_HELD_PAGE_SIZE = 200`; ledger RPCs `resolveRef(ref)` (writes nothing; unknown and expired answer the same) and `listHeld(signalClass, after)` (cursor = the immutable `subject_key`, F2; P-12); `SECURITY_ADMIN_URL` becomes `${CANONICAL_ORIGIN}/admin/security` (I-11: the link ships with its page); routes `GET /admin/security/account-ref/:ref` (one audit row per success: the admin's Access email, `security_ref_resolved`, the ref in `internal_note`, reason "Security alert reference looked up by an administrator", **no** `subjectUserId` — R4) and `GET /admin/security/held?class=&after=`, both behind `requireAdmin` (`apps/api/src/admin/require-admin.ts:21`) and in `ROUTES` beside the other `/admin/*` routes (`routes.ts:395-461`).

The 1,000-decoy case (spec §5 R1/F3; PM ruling I-7): 1,000 decoy accounts at 1,000 events each sit inside the 20,000-row cap, so the real target (31 events) is stored, counted in the byte-capped report's `more`, and named on the admin full list, which pages through every stored row; it is not named in one mail, by F2's design.

- [ ] **Step 1: RED.** The route tests (they include the member-scoped read, the 1,000-decoy case and the health route of Task 26):

```ts
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_HELD_PAGE_SIZE,
  type AdminSecurityHeldResponse,
  type AdminSecurityRefResponse,
  type SecurityAlertMessage,
} from "@thinkersjournal/shared";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { loadBarReason } from "../src/auth/account-status";
import { withClient } from "../src/db/client";
import { loadAccountHistory } from "../src/moderation/account-actions";
import { LIVENESS_KEY } from "../src/durable-objects/SecurityLedgerDO";

/**
 * The security admin routes and the health route (security-alerting spec §2.6
 * N6, R2, R4, F2). The Access JWT is minted the way
 * test/admin-accounts-route.test.ts does it.
 */
const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";
const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;
let adminEmail: string;
const createdUsers: string[] = [];

async function makeJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64urlJson({ iss: `https://${TEAM}`, aud: [AUD], sub: "admin-sub", email: adminEmail, exp: now + 600 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

async function call(path: string, admin = true, e: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = admin ? { "Cf-Access-Jwt-Assertion": await makeJwt() } : {};
  const res = await worker.fetch(new Request(`https://api.test${path}`, { headers }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const ledger = () => env.SECURITY_LEDGER.getByName("ledger");

/** Report one account crossing to the real ledger and read back the ref it minted. */
async function refFor(userId: string): Promise<string> {
  const now = Date.now();
  await ledger().report({
    reports: [
      {
        signal: "targeted_account",
        signalClass: "account",
        subjectKind: "account",
        subject: userId,
        windowStartMs: now - 3_600_000,
        windowEndMs: now,
        observed: 30,
        events: 30,
        threshold: 30,
        severity: "critical",
        byRoute: { "/auth/login": 30 },
      },
    ],
    countedOverflow: {},
  });
  return runInDurableObject(ledger(), (_l, s) =>
    s.storage.sql.exec<{ ref: string }>("SELECT ref FROM account_refs WHERE user_id = ?", userId).one().ref,
  );
}

async function auditRows(ref: string): Promise<{ actor_admin: string; subject_user_id: string | null }[]> {
  return ctxRun(async (c) =>
    (
      await c.query<{ actor_admin: string; subject_user_id: string | null }>(
        "SELECT actor_admin, subject_user_id FROM moderation_actions WHERE action = 'security_ref_resolved' AND internal_note = $1",
        [ref],
      )
    ).rows,
  );
}

async function newUser(): Promise<string> {
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [
      `ref_${crypto.randomUUID()}@example.test`,
    ]);
    return rows[0]?.id ?? "";
  });
  createdUsers.push(id);
  return id;
}

beforeEach(async () => {
  adminEmail = `mod-${crypto.randomUUID()}@example.test`;
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  __resetJwksCacheForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }), { status: 200 })),
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await ctxRun((c) => c.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUsers.splice(0)]));
});

describe("GET /admin/security/account-ref/:ref (N6, R4)", () => {
  it("two alerts about one account carry the same ref; resolving it writes ONE audit row with no subject", async () => {
    const userId = await newUser();
    const ref = await refFor(userId);
    expect(await refFor(userId)).toBe(ref);
    const res = await call(`/admin/security/account-ref/${ref}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as AdminSecurityRefResponse).userId).toBe(userId);
    expect(await auditRows(ref)).toEqual([{ actor_admin: adminEmail, subject_user_id: null }]);
  });

  it("an unknown ref and a ref unused for 7 days give the SAME 404 and write nothing", async () => {
    const unknown = await call(`/admin/security/account-ref/${"f".repeat(32)}`);
    const userId = await newUser();
    const ref = await refFor(userId);
    await runInDurableObject(ledger(), (_l, s) =>
      s.storage.sql.exec("UPDATE account_refs SET last_used_ms = ? WHERE ref = ?", Date.now() - 8 * 86_400_000, ref),
    );
    const expired = await call(`/admin/security/account-ref/${ref}`);
    expect([unknown.status, expired.status]).toEqual([404, 404]);
    expect(await expired.text()).toBe(await unknown.text());
    expect(await auditRows(ref)).toEqual([]);
  });

  it("R3/R4: the member-scoped reads of the account's moderation record never return the audit row", async () => {
    const userId = await newUser();
    const ref = await refFor(userId);
    expect((await call(`/admin/security/account-ref/${ref}`)).status).toBe(200);
    // Positive control: a real ban row for the same account IS returned by both reads.
    await ctxRun((c) =>
      c.query(
        "INSERT INTO moderation_actions (actor_admin, action, subject_user_id, reason) VALUES ('a@example.test', 'user_ban', $1, 'control')",
        [userId],
      ),
    );
    const [history, reason] = await ctxRun(async (c) => [
      await loadAccountHistory(c, userId),
      await loadBarReason(c, userId, { suspended_until: null, disabled_at: new Date(), disabled_reason: "ban" }),
    ] as const);
    expect(reason).toBe("control");
    expect(history.map((h) => h.action)).toEqual(["user_ban"]);
    expect(JSON.stringify(history)).not.toContain(ref);
  });

  it("no Access identity → 401", async () => {
    expect((await call(`/admin/security/account-ref/${"0".repeat(32)}`, false)).status).toBe(401);
  });
});

describe("GET /admin/security/held (F2)", () => {
  it("the full walk lists every remaining row exactly once, though rows change between pages", async () => {
    const keys = await runInDurableObject(ledger(), (_l, s) => {
      s.storage.sql.exec("DELETE FROM held WHERE signal_class = 'ip_burst'");
      for (let i = 0; i < ADMIN_HELD_PAGE_SIZE + 50; i++) {
        const ip = `198.51.${Math.floor(i / 250)}.${i % 250}`;
        s.storage.sql.exec(
          `INSERT INTO held (signal_class, subject_key, signal, subject_kind, subject, events, suppressed, version, updated_ms)
           VALUES ('ip_burst', ?, 'login_ip_burst', 'ip', ?, ?, 1, ?, ?)`,
          `login_ip_burst|${ip}`,
          ip,
          i,
          i + 1,
          Date.now(),
        );
      }
      return s.storage.sql
        .exec<{ k: string }>("SELECT subject_key AS k FROM held WHERE signal_class = 'ip_burst'")
        .toArray()
        .map((r) => r.k);
    });
    const page1 = (await (await call("/admin/security/held?class=ip_burst&after=")).json()) as AdminSecurityHeldResponse;
    expect(page1.rows).toHaveLength(ADMIN_HELD_PAGE_SIZE);
    const deleted = keys.find((k) => !page1.rows.some((r) => r.subjectKey === k)) ?? "";
    await runInDurableObject(ledger(), (_l, s) => {
      s.storage.sql.exec("UPDATE held SET events = 1000000 WHERE subject_key = ?", page1.rows[3]?.subjectKey ?? "");
      s.storage.sql.exec("DELETE FROM held WHERE subject_key = ?", deleted);
    });
    const after = encodeURIComponent(page1.nextAfter ?? "");
    const page2 = (await (await call(`/admin/security/held?class=ip_burst&after=${after}`)).json()) as AdminSecurityHeldResponse;
    const listed = [...page1.rows, ...page2.rows].map((r) => r.subjectKey);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual(keys.filter((k) => k !== deleted).sort());
    expect(page2.nextAfter).toBeNull();
  });

  it("a summary class is a 400; the response orders classes as HELD_PRIORITY does", async () => {
    expect((await call("/admin/security/held?class=storm")).status).toBe(400);
    const ok = (await (await call("/admin/security/held?class=account")).json()) as AdminSecurityHeldResponse;
    expect(ok.classOrder).toEqual(["account", "stuffing", "ip_burst", "infra"]);
  });
});

describe("1,000 decoy accounts (spec §5 R1/F3; PM ruling I-7)", () => {
  it("the real target is not lost: the byte-capped report counts it, and the admin full list names it", { timeout: 120_000 }, async () => {
    const stub = env.SECURITY_LEDGER.getByName(`decoys-${crypto.randomUUID()}`);
    const target = await newUser();
    const sent: SecurityAlertMessage[] = [];
    await runInDurableObject(stub, async (l) => {
      l.armAt = async () => undefined;
      l.siteFor = () => ({ summarise: async () => ({ activity: {}, overflowEvents: 0 }) });
      l.sinkFactory = () => ({ name: "capture", send: async (m) => (sent.push(m), { delivered: true }) });
      const now = Date.now();
      const acct = (subject: string, events: number) => ({
        signal: "targeted_account" as const, signalClass: "account" as const, subjectKind: "account" as const, subject,
        windowStartMs: now - 3_600_000, windowEndMs: now, observed: 30, events, threshold: 30, severity: "critical" as const,
        byRoute: { "/auth/login": events },
      });
      const spend = Array.from({ length: 12 }, (_, i) => acct(`spend-${i}`, 30));
      await l.reportAt({ reports: spend, countedOverflow: {} }, now); // the account budget, spent
      for (let i = 0; i < 1_000; i += 250) {
        await l.reportAt({ reports: Array.from({ length: 250 }, (_, j) => acct(`decoy-${i + j}`, 1_000)), countedOverflow: {} }, now + 1);
      }
      await l.reportAt({ reports: [acct(target, 31)], countedOverflow: {} }, now + 2);
      await l.alarmAt(now + 3); // builds the held report
      await l.alarmAt(now + 4); // delivers it
    });
    const report = sent.find((m): m is Extract<SecurityAlertMessage, { type: "held_report" }> => m.type === "held_report");
    expect(JSON.stringify(report?.entries).length).toBeLessThanOrEqual(64 * 1024);
    expect(report?.more.find((m) => m.signalClass === "account")?.count).toBeGreaterThan(0);
    // The admin full list, paged 200 at a time, names every stored row, the target included.
    const named: string[] = [];
    let after = "";
    for (let page = 0; page < 10; page++) {
      const res = await runInDurableObject(stub, (l) => l.listHeld("account", after));
      for (const r of res.rows) if (r.subject.kind === "account") named.push(r.subject.ref);
      if (res.nextAfter === null) break;
      after = res.nextAfter;
    }
    const ref = await runInDurableObject(stub, (_l, s) =>
      s.storage.sql.exec<{ ref: string }>("SELECT ref FROM account_refs WHERE user_id = ?", target).one().ref,
    );
    expect(named).toContain(ref);
    expect(named.length).toBe(1_000 + 1);
  });
});

describe("GET /health/security-ledger (R2)", () => {
  const throwingLedger = {
    ...env,
    SECURITY_LEDGER: {
      getByName: () => {
        throw new Error("the health route must not call the ledger");
      },
    },
  } as unknown as Env;

  it("a fresh liveness key → exactly the ok body with 200, and no DO call", async () => {
    await env.HEALTH.put(LIVENESS_KEY, String(Date.now()));
    const res = await call("/health/security-ledger", false, throwingLedger);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ status: "ok" }));
  });

  it("a key 2 hours old → the stale body with 503", async () => {
    await env.HEALTH.put(LIVENESS_KEY, String(Date.now() - 2 * 3_600_000));
    const res = await call("/health/security-ledger", false, throwingLedger);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(JSON.stringify({ status: "stale" }));
  });
});
```

The error-envelope inventory (`test/error-envelope.test.ts:735`) fails for every new route until it is probed or allowlisted; the two admin GETs get 401 probes and the health GET an `ERROR_FREE` entry whose `handlerSource` pin was read from the pool's own transform:

```diff
--- a/apps/api/test/error-envelope.test.ts
+++ b/apps/api/test/error-envelope.test.ts
@@ -437,6 +437,18 @@
     name: "401 admin queue with no Access header",
     route: "GET /admin/queue",
     build: () => new Request("https://api.test/admin/queue"),
+  },
+  // Security alerting PR 3 (spec §2.6 N6, F2): the same Access-gate shape as
+  // GET /admin/queue above; test/admin-security-route.test.ts owns the rest.
+  {
+    name: "401 admin security ref lookup with no Access header",
+    route: "GET /admin/security/account-ref/:ref",
+    build: () => new Request(`https://api.test/admin/security/account-ref/${"0".repeat(32)}`),
+  },
+  {
+    name: "401 admin security held list with no Access header",
+    route: "GET /admin/security/held",
+    build: () => new Request("https://api.test/admin/security/held"),
   },
   // GET /admin/media-access-requests (endpoint/UI audit, 2026-09-24) — same
   // shape as GET /admin/queue directly above.
@@ -606,6 +618,18 @@
       // every pin here, breaks loudly if the handler is edited.
       handlerSource:
         'async function handleHealthDb(_request, env, _ctx, _params) { const state = await (0,__vite_ssr_import_0__.readDbProbe)(env); const now = Date.now(); const ageMs = state === null ? null : now - state.lastCheckAt; const isStale = ageMs !== null && ageMs > __vite_ssr_import_0__.STALE_AFTER_MS; const status = state === null ? "unknown" : isStale ? "stale" : state.ok ? "ok" : "down"; // A dumb external HTTP monitor (uptime checker, load balancer health check) // alerts on non-200 — so "ok" is the ONLY 2xx; every other status is 503. const httpStatus = status === "ok" ? 200 : 503; const body = { status, lastCheckAt: state?.lastCheckAt ?? null, ageMs, staleAfterMs: __vite_ssr_import_0__.STALE_AFTER_MS, checkedRecently: !isStale }; // Detail (the raw error string and the recent-probe series) is withheld // from the public/prod response — a leaked connection error (hostname, // driver internals) reads badly surfaced in an incident writeup, and the // recent series is more than an external monitor needs. Gated on the same // TEST_ROUTES flag every other dev/test-only seam uses (src/routes/__test.ts); // a future prod-auth gate can widen this deliberately. if (env.TEST_ROUTES === "1") { body.error = state?.error ?? null; body.latencyMs = state?.latencyMs ?? null; body.recent = state?.recent ?? []; }; return new Response(JSON.stringify(body), { status: httpStatus, headers: { "content-type": "application/json" } }); }',
+    },
+  ],
+  // GET /health/security-ledger (security alerting PR 3, spec §2.6 R2): the same
+  // STATUS-body shape as GET /health/db — 200 {status:"ok"} or 503
+  // {status:"stale"}, never a {code} envelope; no params, one KV read, no DO call.
+  [
+    "GET /health/security-ledger",
+    {
+      reason:
+        "Answers a health STATUS body (200 ok / 503 stale), never a {code} envelope. No params to validate; it reads one KV key and never calls the ledger. See src/routes/health-security-ledger.ts.",
+      handlerSource:
+        'async function handleHealthSecurityLedger(_request, env) { const raw = await env.HEALTH.get((0,__vite_ssr_import_0__.LIVENESS_KEY)); const at = raw === null ? Number.NaN : Number(raw); const ok = Number.isFinite(at) && Date.now() - at < LEDGER_STALE_AFTER_MS; return new Response(JSON.stringify({ status: ok ? "ok" : "stale" }), { status: ok ? 200 : 503, headers: { "content-type": "application/json" } }); }',
     },
   ],
   [
```

- [ ] **Step 2: Implement.**

```ts
import type { SecurityAlertSignal, SecurityAlertSubject, SignalClass } from "./security-alert";

/** `GET /admin/security/account-ref/:ref` (security-alerting spec §2.6 N6). Admin-only. */
export interface AdminSecurityRefResponse {
  readonly userId: string;
  /** The account's handle for `/admin/accounts/:handle`, or null when it has none any more. */
  readonly handle: string | null;
}

/** One stored held row, as the admin page lists it. `events`, `version` and `open` are data, never the order. */
export interface AdminHeldRow {
  readonly subjectKey: string;
  readonly signal: SecurityAlertSignal;
  readonly subject: SecurityAlertSubject;
  readonly events: number;
  readonly suppressed: number;
  readonly version: number;
  /** True while no delivered held-subject report has covered it. */
  readonly open: boolean;
}

/** `GET /admin/security/held?class=&after=`: one page, keyed on the immutable `subject_key` (F2). */
export interface AdminSecurityHeldResponse {
  readonly signalClass: SignalClass;
  readonly rows: readonly AdminHeldRow[];
  /** Pass as `after` for the next page of this class; null when the class is exhausted. */
  readonly nextAfter: string | null;
  /** The classes in `HELD_PRIORITY` order, so the page walks them in turn. */
  readonly classOrder: readonly SignalClass[];
}

/** Rows per admin page (§2.6). */
export const ADMIN_HELD_PAGE_SIZE = 200;
```

```diff
--- a/packages/shared/src/index.ts
+++ b/packages/shared/src/index.ts
@@ -22,3 +22,4 @@
 export * from './security-ledger-policy';
 export * from './security-ledger-types';
 export * from './security-signals';
+export * from './security-admin';
```

```ts
/**
 * The ledger's two admin reads (security-alerting spec §2.6 N6, F2), PR 3.
 * Synchronous over the ledger's SQLite.
 */
import {
  ADMIN_HELD_PAGE_SIZE,
  HELD_PRIORITY,
  SIGNAL_RULES,
  type AdminHeldRow,
  type AdminSecurityHeldResponse,
  type SecurityAlertSignal,
  type SignalClass,
} from "@thinkersjournal/shared";

import { renderSubject } from "./ledger-held";
import { newRef, REF_TTL_MS, type LedgerStore } from "./ledger-store";

type ListRow = {
  subject_key: string;
  signal: string;
  subject_kind: string;
  subject: string;
  events: number;
  suppressed: number;
  version: number;
};

/** Classes in the order `HELD_PRIORITY` first names them: account, stuffing, ip_burst, infra. */
export const HELD_CLASS_ORDER: readonly SignalClass[] = [
  ...new Set(
    HELD_PRIORITY.map((s) => SIGNAL_RULES.find((r) => r.signal === s)?.signalClass).filter(
      (c): c is SignalClass => c !== undefined,
    ),
  ),
];

/** The account a ref names, or null when unknown or unused for 7 days: the same answer for both (§2.6). */
export function resolveRefSync(store: LedgerStore, ref: string, nowMs: number): string | null {
  return (
    store.sql
      .exec<{ user_id: string }>(
        "SELECT user_id FROM account_refs WHERE ref = ? AND last_used_ms >= ?",
        ref,
        nowMs - REF_TTL_MS,
      )
      .toArray()[0]?.user_id ?? null
  );
}

/**
 * Listing is not a message (§2.6: a ref lives 7 days after the last MESSAGE that
 * named the account), so an existing ref is shown without refreshing it. A held
 * account row that no message has named yet gets a ref minted now: the page
 * shows refs, never user ids.
 */
function refForListing(store: LedgerStore, userId: string, nowMs: number): string {
  const found = store.sql.exec<{ ref: string }>("SELECT ref FROM account_refs WHERE user_id = ?", userId).toArray()[0];
  if (found !== undefined) return found.ref;
  const ref = newRef();
  store.sql.exec("INSERT INTO account_refs (user_id, ref, last_used_ms) VALUES (?, ?, ?)", userId, ref, nowMs);
  return ref;
}

/** One page of a class's stored rows, `subject_key > after`, in key order (F2: the cursor never moves). */
export function listHeldSync(
  store: LedgerStore,
  signalClass: SignalClass,
  after: string,
  nowMs: number,
): AdminSecurityHeldResponse {
  const rows = store.sql
    .exec<ListRow>(
      `SELECT subject_key, signal, subject_kind, subject, events, suppressed, version FROM held
       WHERE signal_class = ? AND subject_key > ? ORDER BY subject_key LIMIT ?`,
      signalClass,
      after,
      ADMIN_HELD_PAGE_SIZE,
    )
    .toArray();
  const w = store.watermark(signalClass);
  const listed: AdminHeldRow[] = rows.map((r) => ({
    subjectKey: r.subject_key,
    signal: r.signal as SecurityAlertSignal,
    subject:
      r.subject_kind === "account"
        ? { kind: "account", ref: refForListing(store, r.subject, nowMs) }
        : renderSubject(store, r.subject_kind, r.subject, nowMs),
    events: r.events,
    suppressed: r.suppressed,
    version: r.version,
    open: r.version > w,
  }));
  const last = rows.at(-1);
  return {
    signalClass,
    rows: listed,
    nextAfter: last !== undefined && rows.length === ADMIN_HELD_PAGE_SIZE ? last.subject_key : null,
    classOrder: HELD_CLASS_ORDER,
  };
}
```

```diff
--- a/apps/api/src/durable-objects/SecurityLedgerDO.ts
+++ b/apps/api/src/durable-objects/SecurityLedgerDO.ts
@@ -26,6 +26,7 @@
   selectSecurityAlertSink,
   type CounterReport,
   type LedgerReportBatch,
+  type AdminSecurityHeldResponse,
   type SecurityAlertEnv,
   type SecurityAlertMessage,
   type SecurityAlertSink,
@@ -35,7 +36,9 @@
   type SiteSummaryRpc,
 } from "@thinkersjournal/shared";
 
+import { CANONICAL_ORIGIN } from "../auth/email-verify";
 import { COUNTER_RETENTION_MINUTES } from "./SecurityCounterDO";
+import { listHeldSync, resolveRefSync } from "../security/ledger-admin";
 import { alertFrom, digestFrom, heartbeatFrom, HEARTBEAT_HOUR_UTC } from "../security/ledger-messages";
 import {
   applyCoverage,
@@ -62,11 +65,8 @@
 export const DELIVER_PER_RUN = 20;
 /** Backoff after the 1st, 2nd and 3rd failed delivery; the 4th failure drops the row (§2.6 step 2). */
 export const OUTBOX_BACKOFF_MINUTES: readonly number[] = [1, 5, 30];
-/**
- * `adminUrl` in every held-subject report (§2.6). Null until the admin page
- * ships in PR 3, so no message links to a 404 (PM ruling I-11).
- */
-export const SECURITY_ADMIN_URL: string | null = null;
+/** `adminUrl` in every held-subject report: the page that lists the full held list (§2.6). */
+export const SECURITY_ADMIN_URL = `${CANONICAL_ORIGIN}/admin/security`;
 
 type OutboxRow = { id: number; message: string; covers: string | null; attempts: number };
 
@@ -391,6 +391,16 @@
     });
   }
 
+  /** RPC (PR 3, N6): the account a ref names, or null for an unknown or expired ref. Writes nothing. */
+  async resolveRef(ref: string): Promise<string | null> {
+    return resolveRefSync(this.store, ref, Date.now());
+  }
+
+  /** RPC (PR 3, F2): one page of the full held list for the admin page. */
+  async listHeld(signalClass: SignalClass, after: string): Promise<AdminSecurityHeldResponse> {
+    return this.ctx.storage.transactionSync(() => listHeldSync(this.store, signalClass, after, Date.now()));
+  }
+
   /** RPC from `UserSecurityDO` (§4.4): one `notice_dropped` per drop state per UTC day; the rest counted. */
   async noticeDropped(endState: SecurityNoticeDropped["endState"]): Promise<void> {
     await this.noticeDroppedAt(endState, Date.now());
```

```ts
/**
 * The security admin routes (security-alerting spec §2.6 N6, R4, F2). Same
 * trust domain as routes/admin.ts: Cloudflare Access via `requireAdmin`. Both
 * are GETs, so neither touches the mutating pipeline.
 *
 * ⚠️ THE AUDIT ROW NEVER NAMES THE USER (R4). A successful resolution appends a
 * `moderation_actions` row carrying the admin's identity and the REF, with no
 * `subject_user_id`; once the ref expires (7 days) nothing links the two.
 * Paging the held list writes no row: it shows refs, not users.
 */
import {
  HELD_ROW_CAP,
  type AdminSecurityRefResponse,
  type SignalClass,
} from "@thinkersjournal/shared";

import { requireAdmin } from "../admin/require-admin";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import { recordModerationAction } from "../moderation/actions";

import type { RouteParams } from "../routing";

const REF_RE = /^[0-9a-f]{32}$/;
/** A held `subject_key` is `signal|subject`: bounded, and never more than this. */
const MAX_AFTER_LENGTH = 512;
export const SECURITY_REF_RESOLVED_REASON = "Security alert reference looked up by an administrator";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function isHeldClass(value: string): value is SignalClass {
  return Object.hasOwn(HELD_ROW_CAP, value) && HELD_ROW_CAP[value as SignalClass] > 0;
}

/** `GET /admin/security/account-ref/:ref`. Unknown and expired refs answer the SAME 404 and write nothing. */
export async function handleAdminSecurityRef(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const ref = params.ref ?? "";
  if (!REF_RE.test(ref)) return errorResponse("NOT_FOUND", 404);
  const userId = await env.SECURITY_LEDGER.getByName("ledger").resolveRef(ref);
  if (userId === null) return errorResponse("NOT_FOUND", 404);
  const handle = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    await recordModerationAction(c, {
      actorAdmin: admin.email,
      action: "security_ref_resolved",
      reason: SECURITY_REF_RESOLVED_REASON,
      internalNote: ref,
    });
    const { rows } = await c.query<{ username: string }>(
      "SELECT pr.username FROM profiles pr JOIN users u ON u.id = pr.user_id WHERE u.id = $1 AND u.anonymised_at IS NULL",
      [userId],
    );
    return rows[0]?.username ?? null;
  });
  const body: AdminSecurityRefResponse = { userId, handle };
  return json(body);
}

/** `GET /admin/security/held?class=<class>&after=<subject_key>`: one page of one class, key order. */
export async function handleAdminSecurityHeld(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const url = new URL(request.url);
  const signalClass = url.searchParams.get("class") ?? "account";
  const after = url.searchParams.get("after") ?? "";
  if (!isHeldClass(signalClass) || after.length > MAX_AFTER_LENGTH) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["class", "after"] });
  }
  return json(await env.SECURITY_LEDGER.getByName("ledger").listHeld(signalClass, after));
}
```

```diff
--- a/apps/api/src/routes.ts
+++ b/apps/api/src/routes.ts
@@ -62,6 +62,8 @@
 import { handleHealthBuild } from "./routes/health-build";
 import { handleHealthDb } from "./routes/health-db";
 import { handleHealthSchema } from "./routes/health-schema";
+import { handleHealthSecurityLedger } from "./routes/health-security-ledger";
+import { handleAdminSecurityHeld, handleAdminSecurityRef } from "./routes/admin-security";
 import { handleLogin } from "./routes/login";
 import { handleLogout, handleLogoutAll } from "./routes/logout";
 import { handleUploadMedia } from "./routes/media";
@@ -134,6 +136,9 @@
   // latest name (PM ruling); reads `pgmigrations` through HYPERDRIVE_FRESH.
   // See src/routes/health-schema.ts and scripts/check-migrations-applied.mjs.
   { method: "GET", pattern: "/health/schema", handler: handleHealthSchema },
+  // Security-ledger liveness (security-alerting spec §2.6 R2). Reads ONE KV key,
+  // never the ledger Durable Object; see src/routes/health-security-ledger.ts.
+  { method: "GET", pattern: "/health/security-ledger", handler: handleHealthSecurityLedger },
 
   // ⚠️ Signup and login do NOT run the mutating pipeline (src/auth/pipeline.ts)
   // — they are how a session comes to exist, so its "401 if no session" step
@@ -459,6 +464,10 @@
   // and inline-checkOrigin shape as /admin/decision.
   { method: "GET", pattern: "/admin/appeals", handler: handleAdminListAppeals },
   { method: "POST", pattern: "/admin/appeals/:id/resolve", handler: handleAdminResolveAppeal },
+  // Security alerting (spec §2.6 N6, F2) — same Access trust domain as /admin/whoami.
+  // Both GET: the ref lookup appends an audit row (R4); the held list writes nothing.
+  { method: "GET", pattern: "/admin/security/account-ref/:ref", handler: handleAdminSecurityRef },
+  { method: "GET", pattern: "/admin/security/held", handler: handleAdminSecurityHeld },
 
   // #113 plan B — appeals. by-token is session-less (the emailed token is the
   // authority) and defends itself with inline checkOrigin; the signed-in POST
```

- [ ] **Step 3: GREEN.** `…/api test -- test/admin-security-route.test.ts test/error-envelope.test.ts test/route-protection.test.ts`.

### Task 26: `/health/security-ledger`

**Files:** create `apps/api/src/routes/health-security-ledger.ts`, `apps/web/src/pages/health/security-ledger.ts`, `apps/web/test/security-ledger-health.test.ts`; modify `apps/web/src/lib/cache.ts`, `apps/web/test/page-cache-inventory.test.ts`.

**Produces:** `LEDGER_STALE_AFTER_MS = 2 h`; `handleHealthSecurityLedger` (one KV read of `security-ledger:ok`; `{"status":"ok"}` 200 or `{"status":"stale"}` 503; no DO call, no timestamp — R2); `HEALTH_EDGE_MAX_AGE = 60`, `markHealthCacheable(context)` beside `markFeedCacheable` (`cache.ts:228`): 60 s, no stale-while-revalidate. The web page passes the api's status through, as `pages/health/db.ts:19-20` does.

- [ ] **Step 1: RED.** The api half is in Task 25's file. Web:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { HEALTH_EDGE_MAX_AGE, markHealthCacheable } from "../src/lib/cache";

/**
 * `GET /health/security-ledger` (security-alerting spec §2.6 R2; plan Task 22):
 * the structural tests its sibling /health/db has, plus the helper's contract.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = stripComments(readFileSync(join(__dirname, "..", "src", "pages", "health", "security-ledger.ts"), "utf8"));

describe("GET /health/security-ledger public proxy", () => {
  it("calls apiFetch for exactly the api's route (anti-vacuity anchor)", () => {
    expect(code).toContain('apiFetch<unknown>("/health/security-ledger")');
  });

  it("is edge-cached by markHealthCacheable and by nothing else", () => {
    expect(code).toContain("markHealthCacheable(");
    for (const other of ["markPrivate(", "markPublicCacheable(", "markFeedCacheable("]) expect(code).not.toContain(other);
  });

  it("passes the api's status through, so `stale` (503) reaches a monitor as non-200", () => {
    expect(code).toContain("status: response.status");
  });

  it("is anonymous: the apiFetch call forwards no request", () => {
    expect(code.slice(code.lastIndexOf("apiFetch"))).not.toMatch(/request/);
  });
});

describe("markHealthCacheable", () => {
  const context = (cookie: string | null) => ({
    request: new Request("https://community.thinkersjournal.com/health/security-ledger", {
      headers: cookie === null ? {} : { Cookie: cookie },
    }),
    response: { headers: new Headers() },
    cache: { set: vi.fn() },
  });

  it("60 s at the edge, NO stale-while-revalidate, no tags", () => {
    const ctx = context(null);
    expect(markHealthCacheable(ctx)).toBe(true);
    expect(HEALTH_EDGE_MAX_AGE).toBe(60);
    expect(ctx.cache.set).toHaveBeenCalledWith({ maxAge: 60, swr: 0, tags: [] });
  });

  it("refuses to cache a request that carries a session (control: the case above caches)", () => {
    const ctx = context("tj_session=abc");
    expect(markHealthCacheable(ctx)).toBe(false);
    expect(ctx.cache.set).toHaveBeenCalledWith(false);
  });
});
```

The cache inventory recognises the new helper (otherwise SWEEP A fails the page):

```diff
--- a/apps/web/test/page-cache-inventory.test.ts
+++ b/apps/web/test/page-cache-inventory.test.ts
@@ -125,7 +125,8 @@
   return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
 }
 
-const HELPERS = ["markPublicCacheable", "markFeedCacheable", "markPrivate"] as const;
+// markHealthCacheable: /health/security-ledger only (security-alerting spec §2.6 R2).
+const HELPERS = ["markPublicCacheable", "markFeedCacheable", "markPrivate", "markHealthCacheable"] as const;
 
 const executable = (f: string) => !INERT_EXTENSIONS.has(extname(f));
 
```

- [ ] **Step 2: Implement.**

```ts
/**
 * `GET /health/security-ledger` (security-alerting spec §2.6 R2). Reads ONE KV
 * key, `security-ledger:ok`, which the ledger's alarm writes first on every run.
 * Answers only `{"status":"ok"}` (200) or `{"status":"stale"}` (503): no
 * timestamp, no digest time, and NO Durable Object call, so it is neither an
 * oracle nor a way to wake the ledger from the public internet.
 */
import { LIVENESS_KEY } from "../durable-objects/SecurityLedgerDO";

/** Older than this, the ledger's alarm has stopped (it runs at least hourly). */
export const LEDGER_STALE_AFTER_MS = 2 * 3_600_000;

export async function handleHealthSecurityLedger(_request: Request, env: Env): Promise<Response> {
  const raw = await env.HEALTH.get(LIVENESS_KEY);
  const at = raw === null ? Number.NaN : Number(raw);
  const ok = Number.isFinite(at) && Date.now() - at < LEDGER_STALE_AFTER_MS;
  return new Response(JSON.stringify({ status: ok ? "ok" : "stale" }), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}
```

```diff
--- a/apps/web/src/lib/cache.ts
+++ b/apps/web/src/lib/cache.ts
@@ -234,6 +234,23 @@
   return true;
 }
 
+/**
+ * `/health/security-ledger` ONLY (security-alerting spec §2.6 R2): 60 s at the
+ * edge and NO stale-while-revalidate, so a dead ledger shows within about a
+ * minute of going `stale` and the public route can't be used to hammer KV.
+ * Unlike `/health/db` (markPrivate), this answer carries nothing but ok/stale.
+ */
+export const HEALTH_EDGE_MAX_AGE = 60;
+
+export function markHealthCacheable(context: CacheContext): boolean {
+  if (isViewerSpecific(context)) {
+    refuse(context);
+    return false;
+  }
+  context.cache.set({ maxAge: HEALTH_EDGE_MAX_AGE, swr: 0, tags: [] });
+  return true;
+}
+
 /** Declare a page per-viewer and uncacheable. Every authed page calls this. */
 export function markPrivate(context: CacheContext): void {
   refuse(context);
```

```ts
/**
 * `GET /health/security-ledger` — the PUBLIC readout of the security ledger's
 * liveness (security-alerting spec §2.6 R2), proxied over the Service Binding
 * the way /health/db is. The api answers from ONE KV key and never calls the
 * ledger; this page passes its status through UNCHANGED (a 503 `stale` must
 * reach a monitor as a non-200) and lets the edge hold it for 60 s with no
 * stale-while-revalidate (`markHealthCacheable`, src/lib/cache.ts).
 */
import type { APIRoute } from "astro";

import { apiFetch } from "../../lib/api";
import { markHealthCacheable } from "../../lib/cache";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markHealthCacheable({ request: context.request, response: { headers }, cache: context.cache });
  try {
    const response = await apiFetch<unknown>("/health/security-ledger");
    return new Response(response.text, { status: response.status, headers });
  } catch {
    return new Response(JSON.stringify({ status: "api_unreachable" }), { status: 503, headers });
  }
};
```

- [ ] **Step 3: GREEN.** `pnpm --filter @thinkersjournal/web test -- test/security-ledger-health.test.ts test/page-cache-inventory.test.ts test/cache.test.ts`.

### Task 27: The admin security page

**Files:** create `apps/web/src/pages/admin/security.astro`, `apps/web/src/lib/admin-security.ts`, `apps/web/test/admin-security-page.test.ts`.

The same guard-first shape as the other admin pages (`pages/admin/media-access.astro`; `test/admin-media-access-page.test.ts`), calling `adminApiFetch` directly (there is no generic admin proxy, `lib/admin-api.ts`). It resolves a ref (telling the admin the lookup is recorded) and pages the held list class by class.

- [ ] **Step 1: RED.**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseRef } from "../src/lib/admin-security";

/**
 * `/admin/security` (security-alerting spec §2.6 N6, F2): the
 * structural tests its siblings have (test/admin-media-access-page.test.ts).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const source = stripComments(readFileSync(join(import.meta.dirname, "..", "src", "pages", "admin", "security.astro"), "utf8"));

describe("/admin/security — the JWT-absent guard is the FIRST statement", () => {
  it("positive: reads the Access JWT header and returns 401 on absence", () => {
    expect(source).toContain("Astro.request.headers.get(ACCESS_JWT_HEADER)");
    expect(source).toMatch(/accessJwt === null \|\| accessJwt === ""/);
    expect(source).toMatch(/return new Response\(null, \{ status: 401 \}\);/);
  });

  it("⚠️ the guard comes before markPrivate, the CSP and both api calls", () => {
    const guardAt = source.indexOf("if (accessJwt === null");
    for (const later of ["markPrivate(Astro)", "setPublicPageCsp(Astro)", "/admin/security/account-ref/", "/admin/security/held?"]) {
      const at = source.indexOf(later);
      expect(at, later).toBeGreaterThan(guardAt);
    }
    expect(guardAt).toBeGreaterThan(0);
  });

  it("is never edge-cacheable, and calls adminApiFetch directly (no generic admin proxy)", () => {
    expect(source).not.toContain("markPublicCacheable");
    expect(source).not.toContain("markFeedCacheable");
    expect(source).toContain("adminApiFetch<AdminSecurityRefResponse>(");
    expect(source).toContain("adminApiFetch<AdminSecurityHeldResponse>(");
  });

  it("tells the admin that a lookup is recorded (R4)", () => {
    expect(source).toContain("Every lookup is recorded in the moderation log");
  });
});

describe("parseRef", () => {
  it.each([
    ["0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"],
    ["  0123456789ABCDEF0123456789ABCDEF ", "0123456789abcdef0123456789abcdef"],
    ["0123", null],
    ["../../admin/whoami", null],
    [null, null],
  ])("%j → %j", (input, want) => expect(parseRef(input)).toBe(want));
});
```

- [ ] **Step 2: Implement.**

```ts
/**
 * `/admin/security`'s one pure helper (security-alerting spec §2.6 N6), kept out
 * of the .astro file so it has a plain-Node test. A ref is 16 CSPRNG bytes as 32
 * lowercase hex characters (apps/api/src/security/ledger-store.ts `newRef`).
 */
const REF_RE = /^[0-9a-f]{32}$/;

/** A well-formed ref (trimmed, lowercased), or null: a malformed one never reaches the api. */
export function parseRef(value: string | null): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return REF_RE.test(trimmed) ? trimmed : null;
}
```

```astro
---
/**
 * `/admin/security` — security alerting's admin page (spec §2.6 N6, F2). Two
 * jobs: resolve an alert's opaque account ref to its account, and
 * page through the FULL held list that every held-subject report's `adminUrl`
 * links to (200 rows a page, class by class, cursor = the immutable key).
 *
 * ⚠️⚠️ THE SAME PROPERTY AS THE OTHER ADMIN PAGES (see queue.astro's header): no
 * held subject or account reaches the HTML on a request without a verified
 * Access JWT. The guard is the FIRST statement, before markPrivate, before the
 * CSP, before any api call.
 *
 * ⚠️ A RESOLUTION IS AUDITED. The api appends a `security_ref_resolved` row to
 * the moderation log for every successful lookup (the admin and the ref, never
 * the user, R4). Paging the held list writes nothing.
 */
import BaseLayout from "../../components/BaseLayout.astro";
import { adminApiErrorCode, adminApiFetch } from "../../lib/admin-api";
import { parseRef } from "../../lib/admin-security";
import { markPrivate } from "../../lib/cache";
import { setPublicPageCsp } from "../../lib/csp";

import {
  ACCESS_JWT_HEADER,
  type AdminSecurityHeldResponse,
  type AdminSecurityRefResponse,
  type SignalClass,
} from "@thinkersjournal/shared";

// ⚠️⚠️ THE GUARD — see this file's header.
const accessJwt = Astro.request.headers.get(ACCESS_JWT_HEADER);
if (accessJwt === null || accessJwt === "") {
  return new Response(null, { status: 401 });
}

markPrivate(Astro);
setPublicPageCsp(Astro);

const params = Astro.url.searchParams;
const ref = parseRef(params.get("ref"));
let resolved: AdminSecurityRefResponse | null = null;
let refError: string | null = null;
if (params.get("ref") !== null) {
  if (ref === null) {
    refError = "NOT_FOUND";
  } else {
    const res = await adminApiFetch<AdminSecurityRefResponse>(`/admin/security/account-ref/${encodeURIComponent(ref)}`, {
      accessJwt,
    });
    if (res.status === 200 && res.data !== null) resolved = res.data;
    else refError = adminApiErrorCode(res) ?? "LOOKUP_FAILED";
  }
}

const signalClass = (params.get("class") ?? "account") as SignalClass;
const after = params.get("after") ?? "";
const q = new URLSearchParams({ class: signalClass, after });
const heldResp = await adminApiFetch<AdminSecurityHeldResponse>(`/admin/security/held?${q.toString()}`, { accessJwt });
const held = heldResp.status === 200 ? heldResp.data : null;
const heldError = held === null ? (adminApiErrorCode(heldResp) ?? "LIST_LOAD_FAILED") : null;

/** A subject as the page shows it: a ref (resolvable here), a prefix, or a marker. */
function subjectText(s: AdminSecurityHeldResponse["rows"][number]["subject"]): string {
  if (s.kind === "account") return `account ref ${s.ref}`;
  if (s.kind === "ip_prefix") return s.value;
  return s.kind === "no_ip" ? "(no IP)" : "(site)";
}
---
<BaseLayout title="Security">
  <div class="wrap admin-page">
    <h1>Security</h1>
    <p class="admin-nav"><a class="link" href="/admin/queue">← Moderation queue</a></p>

    <h2>Resolve an alert reference</h2>
    <p class="note">Every lookup is recorded in the moderation log, with your identity and the reference.</p>
    <form method="GET" class="ref-form">
      <label>Reference <input name="ref" required pattern="[0-9a-fA-F]{32}" value={ref ?? ""} /></label>
      <button type="submit" class="btn btn-primary">Resolve</button>
    </form>
    {refError && <p class="err">No such reference (unknown, or unused for 7 days): {refError}</p>}
    {
      resolved && (
        <p class="ok" id="resolved">
          {resolved.handle !== null ? (
            <a class="link" href={`/admin/accounts/${encodeURIComponent(resolved.handle)}`}>@{resolved.handle} →</a>
          ) : (
            <>Account {resolved.userId} (no profile)</>
          )}
        </p>
      )
    }

    <h2>Held subjects</h2>
    {heldError && <p class="err">Could not load the held list: {heldError}</p>}
    {
      held && (
        <>
          <p class="classes">
            {held.classOrder.map((c) => (
              <a class={c === held.signalClass ? "link current" : "link"} href={`?class=${c}`}>{c}</a>
            ))}
          </p>
          {held.rows.length === 0 ? (
            <p id="no-held">Nothing held in {held.signalClass}.</p>
          ) : (
            <table class="held">
              <thead><tr><th>Signal</th><th>Subject</th><th>Events</th><th>Suppressed</th><th>Version</th><th>State</th></tr></thead>
              <tbody>
                {held.rows.map((r) => (
                  <tr>
                    <td>{r.signal}</td><td>{subjectText(r.subject)}</td><td>{r.events}</td>
                    <td>{r.suppressed}</td><td>{r.version}</td><td>{r.open ? "open" : "covered"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {held.nextAfter !== null && (
            <p><a class="link" href={`?class=${held.signalClass}&after=${encodeURIComponent(held.nextAfter)}`}>Next page →</a></p>
          )}
        </>
      )
    }
  </div>
</BaseLayout>
<style>
  .admin-page{padding:clamp(40px,7vw,80px) 0}
  .admin-nav{margin:4px 0 20px}
  .err{color:var(--red, #e5484d)}
  .ok{color:var(--green)}
  .note{color:var(--muted);font-size:14px}
  .ref-form{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:12px 0}
  .classes{display:flex;gap:14px;flex-wrap:wrap}
  .classes .current{font-weight:600}
  .held{width:100%;border-collapse:collapse;margin-top:12px;font-size:14px}
  .held th,.held td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left}
</style>
```

- [ ] **Step 3: GREEN.** `pnpm --filter @thinkersjournal/web test -- test/admin-security-page.test.ts test/page-cache-inventory.test.ts` and `pnpm --filter @thinkersjournal/web typecheck` (`astro check` type-checks the page).

### Task 28: The runbook: health, and the migration order

**Files:** modify `docs/runbooks/deploy.md` — append to Task 7's section, and add `NNNN` after `0023` in "Current order constraint" (`:237`).

````md
### Health

`GET /health/security-ledger` answers `{"status":"ok"}` (200) while the ledger's
alarm has run within 2 hours, else `{"status":"stale"}` (503). It is cached at
the edge for 60 s and makes no Durable Object call. The admin page that every
held-subject report links to is `/admin/security` (Cloudflare Access).
````

### Task 29: PR 3 gate

- [ ] **The PM applies `NNNN` to production before the merge** (spec §6; `docs/runbooks/deploy.md:92-141`): each Worker's build runs `scripts/check-migrations-applied.mjs`, which fails closed until production reports the newest migration applied. Order: apply, merge, retry the builds.
- [ ] The four suites, `pnpm typecheck`, and a full-walk check on a preview: `/admin/security` lists every class, and `/health/security-ledger` answers `ok` after the ledger's first alarm.

---

## Implementer confirmations (spec §5 m5, with this plan's status)

1. Cross-script DO binding with RPC from the Astro web Worker — **open** (Task 7 Step 0).
2. `runInDurableObject` works on the installed pool — **answered** (Tasks 8–9 pass).
3. A stub created inside one request's `waitUntil` can be used by that flush — **answered in the pool** by a test that leaves `stubFor` at its default and finds the row in the real counter instance (Task 11).
4. `getByName()` stubs assignable to `SecurityCounterRpc` — **answered by tsc**.
5. `request.cf.country` vs `CF-IPCountry` in `middleware.ts` — **open** (Task 20 Step 0); `Intl.DisplayNames` in workerd — **answered in the pool** ("Germany", Task 19).
6. Whether DO calls count toward the 10,000-subrequest limit — **open** (Task 21; count one real run).
7. Hyperdrive and outbound `fetch` from inside `UserSecurityDO` — **answered in the pool**; re-check deployed (Task 17 Step 0).
8. (P-7) `this.ctx.id.name` populated inside `UserSecurityDO` for a `getByName` stub — **answered in the pool**; re-check deployed (Task 17 Step 0).

## Revision 2: audit findings and where each is fixed

| Finding | PM ruling | Fix | Where |
|---|---|---|---|
| CR-1 a claimed notice lost when the lookup throws | catch, keep in `retrying` | `sendOrTransient` turns any throw into "transient"; `requeueNotice` (now `settleClaim`, R2-3) keeps the notice and its folds; RED test with a dead Hyperdrive binding; mutation executed | P-5; Tasks 17, 19 |
| I-1 prune budget bypass | hard bound | budget checked before every chunk with `<= 0`; two-target test (`[4500, 5000, 1000]` per call); old loop executed → RED | P-4; Task 9 |
| I-2 delete-after-await (notice fold, report merge) | no delete of possibly-changed state | `inflight_notice` detach in `UserSecurityDO`; `inflight:<id>` detach and subtracted overflow in the counter; two RED race tests; both mutations executed | P-6; Tasks 8, 17, 19 |
| I-3 key unset, runbook a PR late | key set before PR 2 merges; one `config_fault`, no per-login line | PR 2 precondition and gate step; runbook in PR 2; per-login log removed and tested | P-14; Tasks 19, 22, 23 |
| I-4 rotation impossible as written | store, then set; no echo | password-manager first, masked `wrangler secret put` prompt, names-only `secret list`, ordered rotation | Task 22 |
| I-5 tests racing real alarms | use `armAt` | `quietClaim` and `armAt` replaced in the 406, transient and gone tests (and every new claim) | Task 19 |
| I-6a confirmation 3 claimed falsely | real check | test with the default `stubFor`, row read from the real counter | Task 11 |
| I-6b mutation (c) could not go red | must go red | the R1 test now throws in the deliver step; unwrapping it executed → RED | Task 9 |
| I-6c "refuses 4 times" made 3 | really 4 | fourth attempt at +36 min; dropped row, surviving held row and the next hour's naming asserted; mutation executed | Task 9 |
| I-7 dropped spec tests | restore all | deferred content (G2), anonymised direct call, barred reset leaves pending, member-scoped reads, real no-user-id check on ledger output, 1,000 decoys across the report and the admin list | Tasks 9, 19, 25 |
| I-8 `distinctPrefixes` truncated | drop it | spec `classify` restored; field removed; one-line spec amendment | P-2 (withdrawn); Task 2 |
| I-9 unknown owner as account-gone | own outcome, keep retrying | `owner_unknown` log, retried until known or expired; test | P-7; Task 17 |
| I-10 reset-token flood overflows stuffing | own cap and accounting | `net: 50` cap; test; mutation listed | P-13; Task 4 |
| I-11 PR 1 lacks N7; links to a 404 | forget in PR 1; no links before PR 3 | `forgetAccount`, tombstone and both reaper hooks in PR 1; `adminUrl` null until PR 3 | Tasks 9, 13, 25 |
| M-1 DB discipline | only `…_appeals`, never create DBs | Global Constraint; every command; `--exclude test/migrations.db.test.ts`; db test refuses an unset URL | Testing realities; Task 24 |
| M-2 stale task numbers in comments | — | task numbers removed from every code comment | all files |
| M-3 an append diff that did not apply | — | appends printed as code; every remaining diff checked with `git apply --check` while generating this plan | Tasks 18, 21 |
| M-4 wrong citation | — | `limiter-ip-key.ts:24` | Task 3 |
| M-5 digest double-counts a minute; late digest | — | half-open `summarise`; period clamped to retention | P-16; Tasks 8, 9 |
| M-6 unlisted departures | — | listed | P-15 |
| M-7 fixture domains; 50-line rule | — | `example.test`/`example.invalid` only; the exception stated | Global Constraints |
| M-8 tautological assertions | — | literals in the buffer test; decoy test spends purge, storm and ip_burst | Tasks 4, 5 |
| M-9 runbook cites the wrong file | — | cites `deviceHash` in `packages/shared/src/account-notices.ts` | Task 22 |
| M-10 scratch databases left behind | never create DBs | the three databases this plan created in revision 1 were reused, then dropped at the end of revision 2 | — |
| **Revision 3 (re-audit of `6b3bcdb`)** | | | |
| R2-1 N7 best-effort after the `waitUntil` move | guarantee it: await, nightly sweep, held rows covered | both reapers await their forgets after the locks are released; `sweepForgottenAccounts` from the `30 3` cron re-forgets accounts anonymised in 3 days and every ledger-held id that is anonymised or deleted, bounded, idempotent, logged; `held (subject_kind, subject)` index; test with a lost forget recovered; mutation executed | P-17; Tasks 9, 11, 13 |
| R2-2 missing key silent in phase 1 | `config_fault` whatever the notices flag | step 6 checks only the key; P-14 and the runbook corrected; test with notices off → exactly one; mutation executed | P-14; Tasks 18, 22 |
| R2-3 send-now notice not durable | write it to disk at claim; alarm recovers | `claimed_notice` written in the claim's transaction; `settleClaim` clears or folds it back; the alarm recovers it past its due time; test with the route cut off → sent later; mutation executed | P-5, P-6; Tasks 17, 19 |
