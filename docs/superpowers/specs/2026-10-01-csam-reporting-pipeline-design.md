# CSAM Detection → NCMEC Reporting Pipeline — Design

**Status:** Design for PM/founder review, then an implementation plan. Issue **#114**, part 2. This is the
design `2026-09-06-m4-moderation-queue-design.md` §1 points to as "`2026-09-06-csam-reporting-pipeline-design.md` when written".
**Author:** Community controller agent, 2026-10-01.
**Research:** `2026-10-01-ncmec-research-notes.md`, with every claim sourced and marked VERIFIED or UNVERIFIED.

---

## 0. Rulings and facts this design rests on

**CireSnave, verbatim:**
- Requirement (#114): *"the automated CSAM/NCMEC reporting needs to be built sooner rather than later and it
  must exist before we open the community project up to users officially."*
- Trigger (board item 89, Q1): *"Community officially goes live when ThinkersJournal.com makes a link to
  something under community.ThinkersJournal.com visible to most of its users."* That link is ThinkersJournal.com's
  `APP.live` flip; the PM re-gated it on #114 (ThinkersJournal.com PR #32).
- NCMEC's answer (relayed by CireSnave): *"they would leave the decision about whether hash matching was enough to
  flag an account to me as they consider that a site functionality question rather than a legal one. They also said
  that pulling content that might be questionable until it can be reviewed by humans is always the safe legal
  avenue. They also stated that they have hashed versions of questionable content that they make available which is
  likely where Cloudflare gets their feed and that using those for detection and the trigger for human review is
  usually the correct course. As such, filing a report based on a match is acceptable and how we should proceed to
  avoid us getting into questionable legal waters by not doing so. They are fine with us filing a report on a hash
  match without a human in our organization reviewing the match before it is submitted."*

**PM rulings (2026-10-01):** dual intake (A1); images blurred by default with an explicit Reveal (A2); no
notice to a terminated user (A3); outbox + cron (approach 2); filing decoupled from human review (§1′);
manual-paste intake now and an Email Worker later (R2); every uploader of a matched image is barred and
reported, but someone who only embeds it is not (R3). **R1, whether to bar the uploader on an UNREVIEWED
match, is CireSnave's call.** It's built as one switch (§3.4).

**Facts (primary sources, research notes):**
- §2258A(a): report "as soon as reasonably possible after obtaining actual knowledge".
- §2258A(h)(1): the report is a request to preserve "the contents provided in the report for 1 year". Under
  (h)(2), also preserve "any visual depictions, data, or other digital files that are reasonably accessible and may
  provide context". The REPORT Act raised the period from 90 days to 1 year.
- §2258B(c): minimize the employees given access to reported material, and destroy it permanently on a
  law-enforcement request.
- NCMEC ISP Web Services: HTTP Basic auth; `POST /submit` → `POST /upload` → `POST /fileinfo` → `POST /finish`
  (or `/retract` before finish); `GET /status`; XML; prod `report.cybertip.org/ispws`, test
  `exttest.cybertip.org/ispws`. ⚠️ **An unfinished report is deleted by NCMEC 24 h after it was opened or 1 h
  after its last modification, whichever is later.**
- Cloudflare's CSAM Scanning Tool notifies by **daily email only** (no API), and it blocks matched content where
  it can. ⚠️ **Whether it scans R2 objects served via `cdn.thinkersjournal.com` is UNVERIFIED**: the official
  docs never mention R2, and a forum claim says no-store/bypass responses are not scanned. It's an open question
  for CireSnave and must not be assumed as a backstop.
- The XML client must cap response bytes **before** parsing (`2026-09-08-xml-parser-decision.md` §5).

---

## 1. What success looks like

From the moment a match or a human sighting enters the system:
- the content stops being served **at once**;
- every affected image is under a CSAM legal hold;
- a CyberTipline report is **filed automatically within one cron tick**, about 2 minutes, without waiting for a
  human;
- everything the law asks us to keep is kept for at least a year;
- **anything that does not reach "filed" raises an alarm a human cannot miss.** A case that silently sits unfiled
  is the failure this design exists to prevent.

## 2. Architecture

```
Cloudflare daily email ──(v1: moderator pastes paths/hashes; v2: Email Worker)──┐
Moderator sees CSAM in the review queue ───────────────────────────────────────┤
                                                                                 ▼
                                            INTAKE (one Postgres transaction)
          csam legal hold on each key · hide every post/comment embedding it ·
          [bar each uploader — R1 switch] · csam_cases row · ncmec_reports rows 'pending'
                                                                                 │ commit
                          after commit: media move to MEDIA_RESTRICTED · cache purge · epoch bumps
                                                                                 ▼
                    */2 cron DRAIN (per pending report, all steps in one invocation)
                    submit → upload(each file, streamed from R2) → fileinfo → finish
                    every step's result persisted; failures retried with backoff
                                                                                 ▼
                                      ALARMS (daily email · admin banner · log)
                                                                                 ▼
                    REVIEW (after the fact, a human): confirmed | false_positive (→ reversal)
```

It's an outbox drained by the existing `*/2 * * * *` cron, the same shape as the email drain and #61's
`media_moves` queue. No new infrastructure.

## 3. Intake

### 3.1 Entry points

- **(a) Match.** Admin route `POST /admin/csam/matches`, body `{ paths: string[] }`: the matched file paths copied
  from Cloudflare's email (e.g. `https://cdn.thinkersjournal.com/media/post/<sha256>.webp`) or bare sha256
  digests. Each is normalised to an R2 key with `r2KeyForSha256` (`apps/api/src/media/key-pattern.ts`). Anything
  that doesn't resolve is reported back to the moderator by input line, never silently dropped.
  `source = 'cloudflare_match'`; every file gets `viewed_by_esp = false`.
- **(b) Human-spotted.** Admin route `POST /admin/csam/cases`, body `{ subject: "post" | "comment", subjectId }`,
  reached from a "Report as CSAM" control on the review queue and the admin account page. Its keys are the media
  the content embeds, found with the shared helper (§3.2). `source = 'moderator'`; `viewed_by_esp = true`, because a human saw it.
- **(v2, later, separate PR) Email Worker.** Cloudflare Email Routing for the address the CSAM tool notifies
  routes to a Worker that extracts the paths and calls (a)'s intake function. It's built only after one real
  notification email has been captured, since the format is unverified.

### 3.2 Who is affected, and the shared key helper

For each matched key:
- **uploaders**: every `media.owner_id` with that `r2_key`. Media is content-addressed, so several users can hold
  the same object (R3).
- **embedding content**: every post whose `markdown_source` references the key.

Embedding content is hidden. Only **uploaders** are barred and reported (R3).

**Prerequisite (folded into the plan's first task): one media-key helper.** Three copies of the `media/post/<sha256>.webp`
pattern exist today at cc0e009:
- `key-pattern.ts`'s `MEDIA_KEY_SQL_PATTERN`, exported but unused, although its comment claims `reap-orphan-media.ts`
  uses it;
- `reachability.ts`'s private `MEDIA_KEY_REGEX_SQL`;
- `reap-orphan-media.ts`'s inline literal.

All three move onto the one export in `key-pattern.ts`, and the CSAM code uses only that export. It's used in both
directions:
- key → the posts whose `markdown_source` matches, for (a);
- post → its embedded keys, for (b).

Input parsing for (a): each line is either a bare 64-hex sha256 or any URL/path whose path ends in
`media/post/<sha256>.webp`, extracted with the same pattern. The domain is not checked. Everything else is
returned to the moderator as "unrecognised", line by line.

### 3.3 The intake

**New shared primitive (new work, not from plans A/B):** split plan A's `applyAccountAction` into a
transaction-neutral `applyAccountActionInTx(c, input)` plus a wrapper, **exactly as** plan B splits
`applyDecisionInTx` out of `applyDecision`:
- the inner function keeps everything between BEGIN and COMMIT, including its `FOR UPDATE` row lock;
- its early-outs (`not_found`, `already_disabled`) **return without a ROLLBACK**;
- it has no BEGIN, no COMMIT and no try/catch;
- the wrapper owns BEGIN/COMMIT, a swallowed ROLLBACK on the early-outs, and ROLLBACK-and-rethrow on error.

`applyAccountAction`'s observable behaviour is unchanged.

**New `moderation_actions` kind: `csam_hold`** (a migration extends the action CHECK, as 0017 did). Each case
writes exactly one. Every legal hold and every `csam_cases` row references it, so every hold has a
`moderationActionId` whether or not any post embeds the key and whether or not anyone is barred.

**Sequence:**

0. **Resolve, read-only, before the transaction:** the keys **minus any already in `csam_case_files`** (the same
   filter step 2 applies under the lock), then their uploaders (§3.2) and embedding posts. Then **bump the epoch of
   every uploader who will be barred** (plan A's "before" bump; see §3.4 for who is barred). Filtering first means a
   batch that mixes already-cased and new keys does not log out an uploader whose only key was already cased. A key
   cased between this read and the lock costs at most one harmless extra logout, because step 3's authoritative set
   decides who is barred, and the after-commit bump covers anyone new.
1. Open the transaction. Take `pg_advisory_xact_lock(<fixed CSAM_INTAKE lock id>)`. Intake is low-volume, so
   serialising every intake is cheap and closes every intake-vs-intake race.
2. **Idempotence:** `csam_case_files.r2_key` is **UNIQUE**. Inside the lock, drop every key already in
   `csam_case_files`. If none remain, `ROLLBACK` and return the existing case(s) for those keys. Nothing is
   re-filed.
3. Re-resolve uploaders and embedding posts for the remaining keys, inside the transaction. This is the
   authoritative set.
4. Write the `csam_hold` action row (`actor_admin` = the moderator; `subject_user_id` = the first uploader, or
   null; `reason` = fixed internal text naming the case), then the `csam_cases` row referencing it.
5. For each remaining key: `imposeLegalHold(c, { r2Key, category: "csam", imposedBy, moderationActionId: <the csam_hold id> })`.
6. For each embedding post: write a `moderation_snapshots` row (#126's table). This is **a new write path**: today's
   only writer is the author-delete CTE. Then call `applyDecisionInTx(c, { decision: "remove", reason: <fixed internal text>, … })`.
   **No author notice** (A3).
7. For each uploader to be barred (§3.4): `applyAccountActionInTx(c, { kind: "terminate", … })`. A terminate always
   applies: plan A's `already_disabled` early-out excludes `terminate` by construction, and on an already-barred
   account it keeps the original `disabled_at` and sets `disabled_reason = 'terminate'`. The only other outcome is
   `not_found`, for an uploader deleted mid-intake, which is skipped.
7a. For **every** uploader in step 3's set, in id order (lock order): `imposeAccountHoldInTx(c, { userId, category:
    "csam", imposedBy: actorAdmin, reason: <case text>, moderationActionId: holdActionId })` (account-legal-hold spec
    §3 T2). This is **not** a line inside step 7: step 7 loops only over the uploaders §3.4 bars, so adding it there
    would leave every unbarred uploader deletable. Every uploader in a case gets a `csam` account hold in the intake
    transaction, whether or not R1 bars them — a hold blocks deletion, not access.
8. `INSERT csam_case_files` (case id, key, sha256, `viewed_by_esp`). For **each uploader**, `INSERT ncmec_reports`
   (`pending`, or `awaiting_credentials` per §4.4) plus one `ncmec_report_files` row for **each of the case's files
   that uploader's own `media` row holds**. A report attaches only what that person uploaded (R3).
9. COMMIT.

**After commit**, outside the transaction:
- for each hidden post, `afterContentDecision(env, ctx, { subject, result, legalHold: { category: "csam", moderationActionId: <csam_hold id>, imposedBy } })`.
  ⚠️ **The `legalHold` object MUST be passed.** `applyMediaVisibilityChange` (`visibility-hook.ts`) enqueues the
  move unconditionally only on that branch. Without it, it sees the key already held, `continue`s, and the image
  **stays in the public bucket** (AC-C1). The second `imposeLegalHold` this causes is idempotent
  (`ON CONFLICT (r2_key) DO NOTHING`).
- for each key **no post embeds** (an orphan upload): call `enqueueAndAttemptMove(env, ctx, r2Key, "to_restricted")`
  (`apps/api/src/media/moves.ts`), the call `visibility-hook.ts` makes on its legal-hold branch.
- bump the epoch of every barred uploader again (plan A's "after" bump).

### 3.4 R1 — the one pending switch

`CSAM_BAR_UNREVIEWED_MATCH: boolean` is a named constant in `apps/api/src/csam/config.ts`, not an env var, so
nobody can flip it without a reviewed change. Who is barred in step 7: every uploader when the source is
`moderator`, or when the source is `cloudflare_match` **and** the constant is true. **The implementation PR does not
merge until CireSnave has ruled and the constant matches his ruling** (AC-C6).

## 4. Filing (the drain)

### 4.1 State machine (`ncmec_reports.status`)

`awaiting_credentials` → `pending` → `submitted` (`ncmec_report_id` set) → `finished`.

- Transient failures **do not change status**; they set `last_error`, `last_response_code`, `attempts` and
  `next_attempt_at`.
- `failed` is **terminal until a human acts**. It is set only by a `4100` validation failure, which no retry can
  fix. An admin "retry" control moves a `failed` report back to `pending` after the code is fixed, and it's logged.
- Every NCMEC report id lost to the deletion window is appended to `abandoned_report_ids`.

### 4.2 One drain step, per report

Inside a single cron invocation:
1. `pending`: build the report XML, store **the exact bytes** in `request_xml` (preserved, §5), `POST /submit`,
   and record `ncmec_report_id` → `submitted`.
2. For each of **this report's** files (`ncmec_report_files`): stream the object from `MEDIA_RESTRICTED` and
   `POST /upload` with the report id, recording `ncmec_file_id`. Then `POST /fileinfo` with `fileViewedByEsp`,
   `originalFileHash` (sha256) and `publiclyAvailable` (true: it was served publicly before the hold).
3. `POST /finish` → `finished`, with `finished_at`.

Each step persists before the next one starts, so a retry resumes where it stopped.

### 4.3 Failure handling

- A network error, 5xx, or `1000`: status unchanged, backoff (2, 4, 8 … min, capped at 30).
- `2000`/`3100` (authentication/authorization): status unchanged, `last_response_code` recorded, no further
  attempt this tick. This raises an **immediate** alarm (§6, condition 5).
- `4100` (validation): `failed` (terminal), alarm with the error body.
- ⚠️ **The deletion window:** if a `submitted` report isn't finished and `now()` has passed the later of
  (opened + 24 h) and (last modification + 1 h), or NCMEC answers `5001`, move its id to
  `abandoned_report_ids`, clear the per-file NCMEC ids, and go back to `pending`, which submits a fresh report.
- Response bodies are read through a **byte cap before parsing**. The cap is the real control (2026-09-08 decision
  §5). The 64 KiB figure is **this design's choice**, not the decision's: a realistic NCMEC response is a few
  hundred bytes. They're parsed with `fast-xml-parser`, configured `processEntities: false` for parity only. The
  decision found that flag inert for its probed vectors. Request XML is **built** with an escaper, never parsed.
- ⚠️ **Version drift:** the decision's probes ran against **5.10.1**, but `apps/web` now pins **5.11.1** (bumped in
  `8411c70`, 2026-09-20), which **nobody has probed**. **Dependency (an explicit plan step):** add `fast-xml-parser`
  to `apps/api/package.json`, pinned **exactly** to the version being shipped. Turn the decision doc's probes
  (§3–§4: external entity, entity expansion, deep nesting, oversized input) into a version-pinned characterisation
  test against that exact version. It must pass before merge (AC-C12). A failure is a stop, not a test to adjust.

### 4.4 Credentials and environment

Worker secrets `NCMEC_USERNAME`, `NCMEC_PASSWORD`; var `NCMEC_BASE_URL` (exttest vs prod; there's no default, so
a missing value is "not configured"). If they're missing, intake writes `awaiting_credentials`, and the drain
re-checks every tick and promotes those rows to `pending` once all three exist. That state **alarms** (§6).

### 4.5 Report contents

Built from what we hold. Every field below is checked against the live XSD (`GET /xsd`) once credentials exist,
and that check is a plan task.
- `incidentType` (child pornography / CSAM) and `incidentDateTime` (the upload time of that uploader's earliest
  matched media row).
- The reporting person: the ESP contact from config (name and email), supplied by CireSnave.
- The reported person (this report's uploader): `espIdentifier` (user id), `screenName` (handle), `profileUrl`,
  and email. **No IP data**, because we don't store IPs.
- The web page: the URL of every post that embeds one of this report's files.
- Files: this report's `ncmec_report_files` only.

## 5. Preservation (§2258A(h))

| What | Where | Kept |
|---|---|---|
| The images | R2 `MEDIA_RESTRICTED` under a `csam` legal hold (never released by the app) | indefinitely |
| The report as sent | `ncmec_reports.request_xml`; UPDATE of it refused by trigger | ≥ 1 year, no reaper |
| The content (title, source) | `moderation_snapshots` (#126), written in intake step 6 | ≥ 1 year (trigger floor) |
| The account | `users` row barred, never deleted (anonymise/reaper skip barred rows) | indefinitely |
| Who did what | `moderation_actions` (incl. `csam_hold`) + `csam_cases` | append-only |

Access is limited (§2258B(c)): held media is fetchable only through #61's two-person grant. Permanent destruction
on a law-enforcement request is **a manual runbook step** (§8), not app code.
⚠️ **The intake writes snapshots, so #126 must merge before this ships.**

## 6. Alarms — "never silent"

The condition holds when **any** of these is true:
1. a report in `awaiting_credentials`;
2. a report in `failed`;
3. a report not `finished` within 6 h of its case's creation;
4. a non-empty `abandoned_report_ids` on a still-unfinished report;
5. a report whose `last_response_code` is `2000` or `3100`. This one is **immediate**: credentials NCMEC rejects
   cannot heal themselves.

When it holds:
- **Admin banner:** every `/admin/*` page shows a red banner with the count and a link, from
  `GET /admin/csam/alarm`.
- **Email:** the daily `0 14 * * *` tick emails the alarm address (config, CireSnave's) while the condition holds,
  with no dedup suppression. Conditions 2 and 5 **also** send an email on the tick that first raises them, so a
  rejected credential is not left waiting up to a day.
- **Log:** an `ncmec ALARM` line every drain tick while it holds.

## 7. Review (after the fact)

`/admin/csam` lists cases newest first, with NCMEC status and report id. Previews are **blurred**, and **Reveal**
is an explicit control. Revealing logs `media_access` (existing) and is recorded on the case. It does not change
an already-sent report.

A reviewer records `confirmed` or `false_positive` with a statement.
- `confirmed`: a record only.
- `false_positive`: the hidden content is restored through the plan-B inverse path, and any uploader bar lifts
  through the same inverse a ban appeal uses. The legal hold is **not** released automatically; that's
  deliberate and manual (legal-hold.ts). The filed report is **not** retracted (it can't be after finish); the
  runbook covers contacting NCMEC.

Who can review: any Access admin. Access to the **images** keeps #61's two-person rule.

## 8. Out of scope (stated, not forgotten)

- **Email Worker intake (v2)**: after capturing one real Cloudflare notification.
- **Matching NCMEC's hash list at upload** (§2258C): it needs NCMEC's hash-sharing program; it's CireSnave's call
  whether to pursue it.
- **A tool for destruction on law-enforcement request**: a runbook entry in `docs/runbooks/csam.md`, which this
  work creates, covering who, how, and the two-person rule.
- **Telling a terminated user anything** (A3, pending the attorney).
- **Lifting Cloudflare's own block**: a dashboard-only step (Security Center → Blocked Content), in the runbook.

## 9. Acceptance conditions (merge conditions for the implementation PR)

| # | Condition |
|---|---|
| AC-C1 | After a match intake, the content is not publicly reachable: the public routes 404, and the media is out of the public bucket. Tested through the real public endpoints. |
| AC-C2 | No human action stands between intake and `submit`. The drain alone takes a report to `finished` against the NCMEC test double. |
| AC-C3 | A report whose NCMEC deletion window has passed (or a `5001`) is resubmitted, with the old id kept in `abandoned_report_ids`. Shown to fail with the resubmit removed. |
| AC-C4 | Each of §6's five alarm conditions produces the banner and the log line. Conditions 2 and 5 also send the immediate email. Each is shown to fail when its condition is removed. |
| AC-C5 | The response byte cap fires before the parser, and a test of an oversized body fails without the cap. |
| AC-C6 | `CSAM_BAR_UNREVIEWED_MATCH` equals CireSnave's R1 ruling, quoted in the PR. |
| AC-C7 | No email is sent to the uploader or author by any CSAM path (A3). |
| AC-C8 | An end-to-end run against **exttest** (`exttest.cybertip.org`) reaches `finished`, once credentials exist. **APP.live does not flip until this is shown.** |
| AC-C9 | After a match intake, every held image has left the public bucket, **including an orphan upload with no embedding post**. Shown to fail when the post-commit `legalHold` argument is dropped (§3.3). |
| AC-C10 | A second intake of an already-cased key files nothing new (no new case, report, or hold). Shown to fail without the UNIQUE/lock check. |
| AC-C11 | In a multi-uploader case, each NCMEC report carries only the files that uploader's own media rows hold (R3). |
| AC-C12 | The `fast-xml-parser` characterisation test (§4.3) passes against the exact version pinned in `apps/api/package.json`. |

## 10. Dependencies and order

Plan A (built) → plan B (`applyDecisionInTx`, `afterContentDecision`, the inverse paths) → #126 (snapshots) → **this**. This work's own prerequisites, the first tasks of its plan: the `applyAccountActionInTx` split, the shared media-key helper, the `csam_hold` action kind, and the `fast-xml-parser` dependency. Plan C (DSA) is
independent. Building this needs from CireSnave: the R1 ruling, the ESP contact details for `reportingPerson`, an
alarm email address, exttest credentials, and an answer on Cloudflare-scans-R2.
