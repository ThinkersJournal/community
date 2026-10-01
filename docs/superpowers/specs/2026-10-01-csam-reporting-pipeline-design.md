# CSAM Detection → NCMEC Reporting Pipeline — Design

**Status:** Design for PM/founder review, then an implementation plan. Issue **#114**, part 2. This is the
document `2026-09-06-m4-moderation-queue-design.md` §1 refers to as "the CSAM pipeline design, when written".
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
  that the content embeds. `source = 'moderator'`; `viewed_by_esp = true`, because a human saw it.
- **(v2, later, separate PR) Email Worker.** Cloudflare Email Routing for the address the CSAM tool notifies
  routes to a Worker that extracts the paths and calls (a)'s intake function. It's built only after one real
  notification email has been captured, since the format is unverified.

### 3.2 Who is affected

For each matched key:
- **uploaders**: every `media.owner_id` with that `r2_key`. Because media is content-addressed, several users can
  hold the same object (R3).
- **embedding content**: every post whose `markdown_source` references the key, plus comments if comments ever
  carry media. Use the same regex as `reap-orphan-media.ts`, and make it **one shared helper**, not a third copy.

Embedding content is hidden. Only **uploaders** are barred and reported (R3).

### 3.3 The intake transaction

One transaction, using the transaction-neutral primitives plans A/B introduce (`applyDecisionInTx`; and an
`applyAccountActionInTx` split from plan A's `applyAccountAction`, the same split plan B makes for `decide.ts`):

1. `INSERT INTO csam_cases …` returning the case id.
2. For each embedding post or comment, in this order: write a `moderation_snapshots` row (the #126 table) with its
   current title and source, then `applyDecisionInTx(c, { decision: "remove", reason: <fixed internal text>,
   actorAdmin, … })`. **No author notice is sent for a CSAM removal** (A3).
3. For each key: `imposeLegalHold(c, { r2Key, category: "csam", imposedBy, moderationActionId })`.
   `moderationActionId` is the `content_remove` row from step 2 for a post that embeds the key. A key with no
   embedding content (an orphan upload) uses a dedicated `user_terminate` or case-level action row from step 4,
   so step 3 runs after step 4 for those keys.
4. For each uploader, if `CSAM_BAR_UNREVIEWED_MATCH` (R1) is true or the source is `moderator`:
   `applyAccountActionInTx(c, { kind: "terminate", … })`.
5. `INSERT INTO csam_case_files` (key, sha256, `viewed_by_esp`) and `INSERT INTO ncmec_reports` (one per
   uploader, `status = 'pending'`, or `'awaiting_credentials'` when the secrets are absent, §4.4).

Idempotence: a key already under an open case is not re-filed. Intake returns the existing case.

After commit, outside the transaction (mirroring `handleAdminDecision`):
`afterContentDecision(...)` for each hidden target (cache purge plus the move to `MEDIA_RESTRICTED`), and
`bumpEpoch` for each barred account. ⚠️ Plan A's before-and-after double bump applies here too.

### 3.4 R1 — the one pending switch

`CSAM_BAR_UNREVIEWED_MATCH: boolean`, a named constant in `apps/api/src/csam/config.ts` (not an env var, so
nobody can flip it without a reviewed change). **The implementation PR does not merge until CireSnave has ruled
and the constant matches his ruling.** That's a merge condition (§9, AC-C6). Human-spotted cases always bar.

## 4. Filing (the drain)

### 4.1 State machine (`ncmec_reports.status`)

`awaiting_credentials` → `pending` → `submitted` (`ncmec_report_id` set) → `finished` · or `failed`
(retrying) → … · `abandoned_report_ids` accumulates every NCMEC report id lost to its deletion window.

### 4.2 One drain step, per report

Inside a single cron invocation:
1. `pending`: build the report XML, store **the exact bytes** in `request_xml` (preserved, §5), `POST /submit`,
   and record `ncmec_report_id` → `submitted`.
2. For each file: stream the object from `MEDIA_RESTRICTED` and `POST /upload` (multipart, with the report id),
   recording `ncmec_file_id` per file. Then `POST /fileinfo` with `fileViewedByEsp`, `originalFileHash`
   (sha256) and `publiclyAvailable` (true: it was served publicly before the hold).
3. `POST /finish` → `finished`, with `finished_at`.

Each step persists before the next one starts, so a retry resumes where it stopped.

### 4.3 Failure handling

- Any non-zero `responseCode`, network error, or 5xx: set `last_error`, `attempts++`, and
  `next_attempt_at = now() + backoff` (2, 4, 8 … min, capped at 30). Status stays at the last good state.
- ⚠️ **The deletion window:** if a `submitted` report hasn't finished and `now()` has passed the later of
  (opened + 24 h) and (last modification + 1 h), or NCMEC answers `5001` (report doesn't exist), move its id to
  `abandoned_report_ids`, clear the per-file ids, and go back to `pending`, which submits a fresh report.
  Never assume an open report is still there.
- `2000`/`3100` (authentication or authorization): stop retrying this tick, and alarm (credentials problem).
- `4100` (validation): `failed`, alarm with the error body. A code fix is needed; retrying won't help.
- Response bodies are read through a **byte cap (64 KiB) before parsing**, then parsed with `fast-xml-parser`
  using `processEntities: false`, per the 2026-09-08 decision. Request XML is **built** with an escaper, never
  parsed.

### 4.4 Credentials and environment

Worker secrets `NCMEC_USERNAME`, `NCMEC_PASSWORD`; var `NCMEC_BASE_URL` (exttest vs prod; there's no default, so
a missing value is "not configured"). If they're missing, intake writes `awaiting_credentials`, and the drain
re-checks every tick and promotes those rows to `pending` once the secrets appear. That state **alarms** (§6).

### 4.5 Report contents

Built from what we hold. Every field below is checked against the live XSD (`GET /xsd`) once credentials exist,
and that check is a plan task.
- `incidentType` (child pornography / CSAM) and `incidentDateTime` (the upload time of the earliest matched
  media row).
- The reporting person: the ESP contact from config (name and email), supplied by CireSnave.
- The reported person, per uploader: `espIdentifier` (user id), `screenName` (handle), `profileUrl`, and email.
  **No IP data**, because we don't store IPs, so `ipCaptureEvent` is omitted.
- The web page: the URL of every embedding post.
- Files: one per matched key.

## 5. Preservation (§2258A(h))

| What | Where | Kept |
|---|---|---|
| The images | R2 `MEDIA_RESTRICTED` under a `csam` legal hold (never released by the app) | indefinitely |
| The report as sent | `ncmec_reports.request_xml`, append-only; UPDATE refused except for status columns | ≥ 1 year, no reaper |
| The content (title, source) | `moderation_snapshots` (#126); the intake writes one snapshot per hidden post or comment | ≥ 1 year (trigger floor) |
| The account | `users` row barred, never deleted (anonymise/reaper skip barred rows) | indefinitely |
| Who did what | `moderation_actions` + `csam_cases` | append-only |

Access is limited (§2258B(c)): held media is fetchable only through #61's two-person grant. Permanent destruction
on a law-enforcement request is **a manual runbook step** (§8), not app code.
⚠️ **The intake writes snapshots, so #126 must merge before this ships.**

## 6. Alarms — "never silent"

The condition holds when **any** of these is true:
- a report in `awaiting_credentials`;
- a report in `failed`;
- a report not `finished` within 6 h of its case's creation;
- a non-empty `abandoned_report_ids` on a still-unfinished report.

When it holds:
- **Admin banner:** every `/admin/*` page shows a red banner with the count and a link, from
  `GET /admin/csam/alarm`.
- **Email:** the daily `0 14 * * *` tick emails the alarm address (config, CireSnave's) while the condition holds,
  with no dedup suppression. Repeating daily is the point.
- **Log:** an `ncmec ALARM` line every drain tick while it holds, so log-based alerting can key on it once it
  exists.

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
| AC-C4 | Every alarm condition in §6 produces the banner and the log line. Shown to fail when the condition is removed. |
| AC-C5 | The response byte cap fires before the parser, and a test of an oversized body fails without the cap. |
| AC-C6 | `CSAM_BAR_UNREVIEWED_MATCH` equals CireSnave's R1 ruling, quoted in the PR. |
| AC-C7 | No email is sent to the uploader or author by any CSAM path (A3). |
| AC-C8 | An end-to-end run against **exttest** (`exttest.cybertip.org`) reaches `finished`, once credentials exist. **APP.live does not flip until this is shown.** |

## 10. Dependencies and order

Plan A (built) → plan B (`applyDecisionInTx`, the inverse paths) → #126 (snapshots) → **this**. Plan C (DSA) is
independent. Building this needs from CireSnave: the R1 ruling, the ESP contact details for `reportingPerson`, an
alarm email address, exttest credentials, and an answer on Cloudflare-scans-R2.
