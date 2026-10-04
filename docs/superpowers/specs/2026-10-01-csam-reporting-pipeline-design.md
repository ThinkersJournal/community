# CSAM Detection → NCMEC Reporting Pipeline — Design

**Status:** Revision 1 (2026-10-04), for PM review, then the implementation plan. Issue **#114**, part 2. This is the
design `2026-09-06-m4-moderation-queue-design.md` §1 points to as "`2026-09-06-csam-reporting-pipeline-design.md` when written".
Revision 1 applies CireSnave's R1 ruling (quarantine and review, no bar on an unreviewed match) and his report-timing
ruling ("Option B"), and brings every code reference up to `origin/main` at `9a76b6f` (0.1.4, last migration `0025`).
**Author:** Community controller agent, 2026-10-01; revised 2026-10-04.
**Research:** `2026-10-01-ncmec-research-notes.md`, with every claim sourced and marked VERIFIED or UNVERIFIED.
§0 adds two facts read from NCMEC's documentation page on 2026-10-04.

There is **no attorney** on this project. CireSnave, verbatim: *"There is no attorney nor can I afford one so proceed
with best safe guesses."* Every point below that is a reading of the law, not a fact, is marked
**⚠️ Legal uncertainty**, with the reading this design takes.

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
- **R1 (relayed by the PM, 2026-10-04):** *"On a CSAM hash match, block the content that matched from being
  shareable but do not immediately ban the user. We can begin the process of determining whether the content is a
  real violation or not at that point but shouldn't act on it as if that determination had already been made. For
  example, a mother holder her naked newborn baby in her arms is not in the same ballpark as a child predator sharing
  naked baby pictures and yet both might match a similar search. The mother should not be banned while the child
  predator should be reported and banned. We need to be careful walking that line to not stomp on good people's toes
  more than necessary while also being reactive enough to quickly ban child predators."*
- **Report timing (board item 125, relayed by the PM, 2026-10-04):** *"Option B."* As put to him: for KNOWN-HASH
  matches only, report to NCMEC at the moment of the match and keep the account ACTIVE until a moderator reviews;
  the ban follows only on a moderator's CONFIRM, because reporting is not banning; classifier flags never
  auto-report.
- **Scanning (R2, relayed by the PM, 2026-10-04):** *"we should periodically run our own scans of all new images.
  Relying on Cloudflare is a good first line of defense but since children's safety is at risk and thus our legal
  standing is at risk, we must check all images ourselves."* That scanner is designed in a **separate document on
  another branch**. This design only fixes how its results enter the pipeline (§3.1).
- **ESP contact and alarm address:** *"that should be my credentials ... That email is where any urgent alarms
  should be sent."* The values are **supplied by the operator as secrets** (§4.4, §6) and never appear in the repo.

**PM rulings (2026-10-01), still standing:** dual intake (A1); images blurred by default with an explicit Reveal
(A2); no notice to a terminated user (A3); outbox + cron (approach 2); manual-paste intake now and an Email Worker
later; every uploader of a matched image is reported, and on CONFIRM barred, but someone who only embeds it is not
(R3).

**Facts (primary sources, research notes):**
- §2258A(a)(1)(A): report "as soon as reasonably possible after obtaining actual knowledge".
- §2258A(h)(1): a completed report is a request to preserve "the contents provided in the report for 1 year". Under
  (h)(2), also preserve "any visual depictions, data, or other digital files that are reasonably accessible and may
  provide context". The REPORT Act raised the period from 90 days to 1 year.
- §2258B(c): minimize the employees given access to reported material, and destroy it permanently on a
  law-enforcement request.
- NCMEC ISP Web Services: HTTP Basic auth; `POST /submit` → `POST /upload` → `POST /fileinfo` → `POST /finish`
  (or `/retract` before finish); `GET /status`; XML; prod `report.cybertip.org/ispws`, test
  `exttest.cybertip.org/ispws`. ⚠️ **An unfinished report is deleted by NCMEC 24 h after it was opened or 1 h
  after its last modification, whichever is later.**
- **New, read from `report.cybertip.org/ispws/documentation` on 2026-10-04 (VERIFIED as the fetch tool's summary,
  same caveat as the research notes):**
  - *"A report may be cancelled by a reporter before the report has been finished or it has been automatically
    cancelled by NCMEC after timing out."* and *"Once a report is finished, additional files or file details cannot
    be added and the report cannot be cancelled."* Response code `5102` = "Report already finished".
  - The documentation describes **no** mechanism to amend, supplement or withdraw a finished report. The only
    cross-report link is `<priorCTReports>` ("A report ID for a prior CyberTipline report on this reported person
    or user"), which lives **inside a new report** about a person. `fileViewedByEsp` means "the reporting company
    viewed the entire contents of the file being reported to NCMEC."
- Cloudflare's CSAM Scanning Tool notifies by **daily email only** (no API), and it blocks matched content where
  it can. ⚠️ **Whether it scans R2 objects served via `cdn.thinkersjournal.com` is UNVERIFIED.** R2's ruling makes
  our own scanning the answer, so Cloudflare is no longer assumed to be the only detector.
- The XML client must cap response bytes **before** parsing (`2026-09-08-xml-parser-decision.md` §5).

---

## 1. What success looks like

From the moment a detection or a human sighting enters the system:
- the matched content stops being served **at once** (quarantine), and only the legal-hold audience can fetch it;
- the evidence is preserved from that moment;
- the uploader's account **stays active** until a moderator decides (R1);
- for a **known-hash match**, a CyberTipline report is **filed automatically within one cron tick** (about 2
  minutes) without waiting for a human ("Option B"); for anything else, it is filed in the moderator's CONFIRM;
- a moderator is alarmed **urgently** and keeps being alarmed until the case is decided;
- **anything that does not reach "filed", and any case nobody has decided, raises an alarm a human cannot miss.**

## 2. Architecture

```
Cloudflare daily email ─(v1 paste; v2 Email Worker)─┐   known-hash
Self-scan vs hash list (separate doc) ──────────────┤   known-hash
Self-scan classifier (separate doc, future) ────────┤   classifier
Moderator sees CSAM in the review queue ────────────┤   moderator sighting
                                                    ▼
                         INTAKE (one Postgres transaction)
   quarantine: csam media hold on each key · hide every post embedding it · snapshots ·
   csam account hold on each uploader (access untouched) · csam_cases row (priority, alarm_next_at=now) ·
   ncmec_reports rows 'pending' — known-hash only, CSAM_REPORT_AT_MATCH
   [moderator sighting only: the CONFIRM transaction runs here too]
                                                    │ commit
          after commit: media move to MEDIA_RESTRICTED · cache purge · URGENT email (best effort)
                                                    ▼
        */2 cron: NCMEC DRAIN (submit → upload → fileinfo → finish) · CASE ALARMS (URGENT every 4 h)
                                                    ▼
                         REVIEW (a human, target 24 h — a proposal)
             CONFIRM: terminate each uploader · queue any report not yet queued · keep holds
             CLEAR:   lift the quarantine (evidence copy kept) · withdraw an unfiled report · audit
```

It's an outbox drained by the existing `*/2 * * * *` cron (`apps/api/src/index.ts:90`), the same shape as the
email drain and #61's `media_moves` queue. No new infrastructure.

## 3. Intake

### 3.1 Detection kinds and entry points

Every case records **where** the detection came from (`source`) and **what kind** of signal it is (`kind`). The
kind decides the review priority and whether a report is queued at match.

| `kind` | `source` values | Confidence | Reported at match? | Priority |
|---|---|---|---|---|
| `known_hash` | `cloudflare_match`, `self_scan` | High: the file's hash is on an industry/NCMEC list | **Yes** when `CSAM_REPORT_AT_MATCH` (§3.4) | `urgent` |
| `classifier` | `self_scan` | Low: an ML "possibly CSAM" score. CireSnave's newborn example is this kind. | **Never**, under either constant value | `high` (proposal, §6.2) |
| `moderator_sighting` | `moderator` | A human looked | Yes, at intake: the sighting **is** the confirmation (§3.5) | — (decided at intake) |

A CHECK pins the pairs: `cloudflare_match` → `known_hash`; `self_scan` → `known_hash` or `classifier`;
`moderator` → `moderator_sighting`. Both machine kinds enter **the same quarantine and review pipeline**; they
differ only in the report timing and the alarm cadence.

- **(a) Cloudflare match.** Admin route `POST /admin/csam/matches`, body `{ lines: string[] }`: the matched file
  paths copied from Cloudflare's email (e.g. `https://cdn.thinkersjournal.com/media/post/<sha256>.webp`) or bare
  sha256 digests. Each is normalised to an R2 key with `r2KeyForSha256` (`apps/api/src/media/key-pattern.ts:12`).
  Anything that doesn't resolve is reported back to the moderator by input line, never silently dropped.
- **(b) Self-scan.** The separate scanning design calls the same intake function, `runIntake`, with
  `source = 'self_scan'`, `kind = 'known_hash'` for a hash-list match or `kind = 'classifier'` for a classifier
  flag, and a system actor (`system:self-scan`). Nothing in this design depends on how the scanner works.
- **(c) Human-spotted.** Admin route `POST /admin/csam/cases`, body `{ subject: "post", subjectId }`, reached from a
  "Report as CSAM" control on the review queue and the admin account page. Its keys are the media the post embeds,
  found with the shared helper (§3.2).
- **(v2, later, separate PR) Email Worker** for (a). It's built only after one real Cloudflare notification email
  has been captured, since the format is unverified.

`viewed_by_esp` (NCMEC's `fileViewedByEsp`) is recorded **per report file, when the report is queued**: `false` for
a report queued at match (nobody has viewed it), `true` for a report queued at a CONFIRM whose reviewer revealed the
file (§7), and `true` for a moderator sighting.

### 3.2 Who is affected, and the shared key helper

For each matched key:
- **uploaders**: every `media.owner_id` with that `r2_key`. Media is content-addressed, so several users can hold
  the same object (R3).
- **embedding content**: every post whose `markdown_source` references the key. Comments carry no media
  (`reachability.ts:55` scans posts' markdown; comments embed none).

Embedding content is quarantined. Only **uploaders** are reported and, on CONFIRM, barred (R3).

**Prerequisite (the plan's first task): one media-key helper.** Copies of the `media/post/<sha256>.webp` SQL
pattern at `9a76b6f`:
- `key-pattern.ts:9`'s `MEDIA_KEY_SQL_PATTERN`, exported but imported by nothing, although its comment claims
  `reap-orphan-media.ts` uses it;
- `reachability.ts:16`'s private `MEDIA_KEY_REGEX_SQL`;
- `reap-orphan-media.ts:71` and `:77`'s two inline literals (posts, and `moderation_snapshots` since #126).

All of them move onto the one export, and the CSAM code uses only that export, in both directions: key → posts,
and post → keys. Input parsing for (a): each line is either a bare 64-hex sha256 or any URL/path whose path ends in
`media/post/<sha256>.webp`. The domain is not checked.

### 3.3 The intake transaction (quarantine)

**New shared primitive (the plan's second task):** split plan A's `applyAccountAction`
(`apps/api/src/moderation/account-actions.ts:66`) into a transaction-neutral `applyAccountActionInTx(c, input)`
plus a wrapper, **exactly as** plan B split `applyDecisionInTx` (`decide.ts:90`) out of `applyDecision`
(`decide.ts:181`). Intake no longer calls it (R1), but CONFIRM (§3.5) and a moderator sighting do.

**New `moderation_actions` kinds:** `csam_hold`, `csam_review` and `csam_clear_release` (a migration extends the
action CHECK; the latest list is `0022_account_legal_holds.sql:70`). Each case writes exactly one `csam_hold`.
Every legal hold and every `csam_cases` row references it.

**Sequence:**

0. **Resolve, read-only, before the transaction:** the keys minus any already **suppressed** (§3.6), then their
   uploaders and embedding posts. (No epoch bump: nobody is barred at match.)
1. Open the transaction (`BEGIN_BOUNDED_TX`). Take `pg_advisory_xact_lock(<CSAM_INTAKE lock id>)`. Intake is
   low-volume, so serialising every intake is cheap and closes every intake-vs-intake race.
2. **Idempotence / suppression:** inside the lock, drop every suppressed key (§3.6). If none remain, `ROLLBACK` and
   return the existing case(s). Nothing is re-filed, and nothing re-alarms.
3. Re-resolve uploaders and embedding posts for the remaining keys, inside the transaction. This is the
   authoritative set.
4. Write the `csam_hold` action row (`actor_admin` = the moderator or the system actor; `subject_user_id` = the
   first uploader, or null; `reason` = fixed internal text naming the case), then the `csam_cases` row
   (`source`, `kind`, `priority`, `alarm_next_at = now()`).
5. **Quarantine the media.** For each remaining key: `imposeLegalHold(c, { r2Key, category: "csam", imposedBy,
   moderationActionId: <the csam_hold id> })` (`legal-hold.ts:19`). This is the existing #61 restricted path, not
   a new one: a held key is served **only** by `GET /media/restricted/:sha256` to an Access admin holding an
   approved two-person grant (`media_access_requests`; `media-restricted.ts:81-135`), and every other caller gets a
   404. The hold also makes `applyMediaVisibilityChange` skip any later public move of that key
   (`visibility-hook.ts:56-57`).
6. **Quarantine the content.** For each embedding post: write a `moderation_snapshots` row (#126's table;
   `INSERT (post_id, author_id, title, body_markdown)`, the shape `posts.ts:515` uses), then call
   `applyDecisionInTx(c, { subject: "post", subjectId, decision: "keep_hidden", reason: <fixed text>, actorAdmin })`.
   `keep_hidden`, not `remove`: R1 says not to act as if the determination had been made, and both set `hidden_at`
   (`decide.ts:76-80`). **No author notice** (nothing is minted or sent from intake).
   ⚠️ `applyDecisionInTx` also resolves every confirmed open DSA notice on the post (`decide.ts:144`), and
   `afterContentDecision` emails those **reporters** the `reason` verbatim (`after-content-decision.ts:59-64`). The
   fixed `reason` is therefore reporter-safe text ("Hidden pending a child-safety review"), and never names a hash,
   a case or the uploader.
7. *(Removed by R1: no uploader is barred at match.)*
7a. For **every** uploader in step 3's set, in id order (lock order): `imposeAccountHoldInTx(c, { userId, category:
    "csam", imposedBy, reason: <case text>, moderationActionId: holdActionId })` (`account-holds.ts:98`). **A hold
    blocks deletion, not access** (`anonymise-accounts.ts:107,226` and `reap-unverified.ts:69` skip held users;
    nothing on the login or session path reads `account_legal_holds`). **It is imposed at match, not at
    confirmation**, because under "Option B" a known-hash match is reported at once, and §2258A(h) then asks us
    to preserve the reported person's data for a year; a user who is quietly deleting their account between the
    match and the review would otherwise take the report's subject data with them. It costs a false-positive
    user nothing they can see. ⚠️ A `csam` account hold can never be released by app code
    (`releaseAccountHold` refuses it, `account-holds.ts:162`); see §7.3 for what that means after a CLEAR.
8. `INSERT csam_case_files` (case id, key, sha256, kind). **If `kind = 'known_hash'` and `CSAM_REPORT_AT_MATCH`**:
   for each uploader, `INSERT ncmec_reports` (`pending`, or `awaiting_credentials` per §4.4) plus one
   `ncmec_report_files` row (`viewed_by_esp = false`) for each of the case's files that uploader's own `media` row
   holds (R3). For `classifier`, nothing is queued, under either constant value.
9. COMMIT.

**After commit**, outside the transaction:
- for each hidden post, `afterContentDecision(env, ctx, { subject: "post", decision: "keep_hidden", reason, result,
  legalHold: { category: "csam", imposedBy } })`. Its real signature takes `legalHold: { category, imposedBy }`
  (`after-content-decision.ts:26`) and fills `moderationActionId` from the decision's own `result.actionId`
  (`:50-53`). ⚠️ **The `legalHold` object MUST be passed.** `applyMediaVisibilityChange` enqueues the move
  unconditionally only on that branch (`visibility-hook.ts:42-53`). Without it, it sees the key already held,
  `continue`s, and the image **stays in the public bucket** (AC-C1). Its second `imposeLegalHold` is a no-op
  (`ON CONFLICT (r2_key) DO NOTHING`, `legal-hold.ts:31`), so the hold keeps step 5's `csam_hold` id.
- for each key **no post embeds** (an orphan upload): `enqueueAndAttemptMove(env, ctx, r2Key, "to_restricted")`
  (`moves.ts:41`), the call `visibility-hook.ts:52` makes on its legal-hold branch.
- send the case's first **URGENT** alarm email (§6.2), best effort. The case row's `alarm_next_at = now()` is the
  durable queue: if this send fails or the Worker dies, the next drain tick sends it.

### 3.4 The two switches — R1 and report timing

Both are named constants in `apps/api/src/csam/config.ts`, not env vars, so nobody can flip either without a
reviewed change.

```ts
// R1 (CireSnave, verbatim, relayed by the PM 2026-10-04): "On a CSAM hash match, block the content that
// matched from being shareable but do not immediately ban the user. We can begin the process of determining
// whether the content is a real violation or not at that point but shouldn't act on it as if that determination
// had already been made. For example, a mother holder her naked newborn baby in her arms is not in the same
// ballpark as a child predator sharing naked baby pictures and yet both might match a similar search. The mother
// should not be banned while the child predator should be reported and banned. We need to be careful walking
// that line to not stomp on good people's toes more than necessary while also being reactive enough to quickly
// ban child predators."
export const CSAM_BAR_UNREVIEWED_MATCH = false;

// Report timing, board item 125 (CireSnave, verbatim, relayed by the PM 2026-10-04): "Option B."
// KNOWN-HASH matches only: the report is queued in the intake transaction. Classifier flags never auto-report.
export const CSAM_REPORT_AT_MATCH = true;
```

- `CSAM_BAR_UNREVIEWED_MATCH = false`: no machine detection bars anyone. Bars happen only in CONFIRM (§3.5). The
  constant stays, at `false`, so the code that would read it is a single, reviewed place; with it `false`, intake
  has no bar branch at all.
- `CSAM_REPORT_AT_MATCH = true`: applies to `kind = 'known_hash'` only. With it `false` (the alternative CireSnave
  did not choose), a known-hash report would be queued in CONFIRM instead, exactly like a classifier report. Both
  branches are built and tested, so a future change is one reviewed line.
- **The implementation PR does not merge until both constants equal CireSnave's quoted words** (AC-C6).

### 3.5 CONFIRM — "actual knowledge"

A moderator's CONFIRM runs **one transaction**:
1. lock the case row (`FOR UPDATE`); refuse if already decided;
2. require every case file to have been **revealed** by the reviewer (`csam_case_files.revealed_at`, §7): a
   decision on a file nobody looked at is not a review;
3. for each uploader: `applyAccountActionInTx(c, { kind: "terminate", … })` (plan A's terminate,
   `account-actions.ts:63`: `disabled_at = COALESCE(u.disabled_at, now())`, `disabled_reason = 'terminate'`, and
   `already_disabled` never applies to a terminate, `:82`). **A terminate is never appealable**
   (`routes/appeals.ts:54-60`: a `user_terminate` action has no appeal target; `moderation/appeals.ts:197-202`: a
   ban appeal never lifts a `terminate`);
4. for each uploader **with no report already queued for this case**, queue one (`pending` or
   `awaiting_credentials`; files with `viewed_by_esp = true`). Under "Option B" a known-hash case already has its
   reports, so this queues only classifier reports;
5. keep every hold (media and account); write the `csam_review` action and set `review_outcome = 'confirmed'`.

After commit: the epoch bump before **and** after the transaction for each terminated uploader (plan A's rule,
`account-actions.ts:8-11`), and the alarm stops for this case.

A **moderator sighting** (§3.1 c) runs intake and this CONFIRM in the **same** transaction, with the opening
moderator as the reviewer and the files `viewed_by_esp = true`: the person reporting it saw it.

**When we have "actual knowledge" — the reading this design takes.**
- Under R1, a moderator's CONFIRMATION is treated as the point of "actual knowledge" for 18 U.S.C. §2258A(a)
  ("as soon as reasonably possible after obtaining actual knowledge"). Every report not already queued is queued
  **in the CONFIRM transaction**, so the duty is met within one drain tick of the decision.
- For **known-hash** matches, CireSnave chose to report **at the match** anyway ("Option B"): reporting is not
  banning, and NCMEC told him a report on a hash match is acceptable. That makes the question below moot for
  known-hash matches, but not for classifier flags, which are reported only on CONFIRM.
- ⚠️ **Legal uncertainty:** whether a known-hash match is itself "actual knowledge" is **unsettled**. Reporting
  known-hash matches at match time is the safe side of that question. A classifier flag is plainly not actual
  knowledge on its own; this design treats it as a reason to look.

### 3.6 Suppression — re-detecting a decided file

`csam_case_files` is unique on `(r2_key, kind)`. At intake a key is **suppressed**, and files nothing new, when:
- it has a case that is still **undecided** or was **confirmed**, of any kind (it is already quarantined); or
- it was **cleared** in a case of the **same or a stronger** kind (`known_hash` > `classifier`).

So a file a moderator cleared does not re-alarm when Cloudflare's next daily email, or the next scan, names it
again; the intake answers `already_cased` naming the cleared case, and the moderator sees that outcome. A file
cleared as a **classifier** flag that later turns up on a **known-hash list** opens a new case, because the new
signal is stronger. A moderator who wants to re-open a cleared file uses the "Report as CSAM" control (§3.1 c),
which is never suppressed.

### 3.7 Re-upload of a quarantined file

⚠️ **Existing gap, found while revising (`apps/api/src/routes/media.ts:192-200`):** `POST /media` re-`put`s the
content-addressed object into the **public** `MEDIA` bucket unconditionally ("Unconditional put: the key IS the
content hash"). Re-uploading the identical file would therefore put a held object back at its public URL. The
earlier design barred the uploader at match, which hid this; under R1 the uploader stays active, so it must close.

The upload route checks `isKeyLegallyHeld` (`legal-hold.ts:36`) for the output key **before** the `put`. A held
key is refused with the route's one existing `415 UNSUPPORTED_MEDIA_TYPE` body (`media.ts:73-77`), deliberately
identical to every other refusal so it tells a prober nothing, with no `media` row and no R2 write, and the attempt is appended to `csam_upload_attempts` (case, user, time) when the hold is a `csam` one,
so the reviewer sees it. Whether a re-upload changes the case is the reviewer's call; it does not bar anyone.

## 4. Filing (the drain)

### 4.1 State machine (`ncmec_reports.status`)

`awaiting_credentials` → `pending` → `submitted` (`ncmec_report_id` set) → `finished`; plus `failed` (terminal
until a human acts), `retract_pending` and `withdrawn` (§7.2).

- Transient failures **do not change status**; they set `last_error`, `last_response_code`, `attempts` and
  `next_attempt_at`.
- `failed` is set only by a `4100` validation failure, which no retry can fix. An admin "retry" control moves a
  `failed` report back to `pending` after the code is fixed, and it's logged.
- Every NCMEC report id lost to the deletion window is appended to `abandoned_report_ids`.
- ⚠️ **Every drain transition is a guarded write**: `UPDATE … WHERE id = $1 AND status = <the status it read>`.
  A CLEAR that changed the status while a network call was in flight wins; §7.2 says what the drain then does.

### 4.2 One drain step, per report

Inside a single cron invocation:
1. `pending`: build the report XML, store **the exact bytes** (`ncmec_submissions`, preserved, §5), `POST /submit`,
   and record `ncmec_report_id` → `submitted`.
2. For each of **this report's** files (`ncmec_report_files`): stream the object from `MEDIA_RESTRICTED` and
   `POST /upload` with the report id, recording `ncmec_file_id`. Then `POST /fileinfo` with `fileViewedByEsp` (the
   file's `viewed_by_esp`), `originalFileHash` (sha256) and `publiclyAvailable` (true: it was served publicly before
   the hold).
3. `POST /finish` → `finished`, with `finished_at`.
4. `retract_pending`: `POST /retract` → `withdrawn` (§7.2). A `5102` (already finished) → `finished`, flagged on
   the case for the runbook.

Each step persists before the next one starts, so a retry resumes where it stopped. **A report queued at match
goes through exactly this drain, and the same exttest-first path (AC-C8):** nothing files to production until an
exttest run has reached `finished` and the production credentials exist.

### 4.3 Failure handling

- A network error, 5xx, or `1000`: status unchanged, backoff (2, 4, 8 … min, capped at 30).
- `2000`/`3100` (authentication/authorization): status unchanged, `last_response_code` recorded, no further
  attempt this tick. This raises an **immediate** alarm (§6, condition 5).
- `4100` (validation): `failed` (terminal), alarm with the error body.
- ⚠️ **The deletion window:** if a `submitted` report isn't finished and `now()` has passed the later of
  (opened + 24 h) and (last modification + 1 h), or NCMEC answers `5001`, move its id to
  `abandoned_report_ids`, clear the per-file NCMEC ids, and go back to `pending`, which submits a fresh report.
- Response bodies are read through a **byte cap before parsing**. The cap is the real control (2026-09-08 decision
  §5). The 64 KiB figure is **this design's choice**. They're parsed with `fast-xml-parser`, configured
  `processEntities: false` for parity only. Request XML is **built** with an escaper, never parsed.
- ⚠️ **Version drift:** the decision's probes ran against **5.10.1**; `apps/web` pins a later version that nobody
  has probed. Add `fast-xml-parser` to `apps/api/package.json`, pinned **exactly** to the version being shipped, and
  turn the decision doc's probes (§3–§4) into a version-pinned characterisation test (AC-C12). A failure is a stop.

### 4.4 Credentials, reporter contact and environment

Worker secrets, all **supplied by the operator as secrets** (`wrangler secret put`), never committed and never
written into any doc, commit or PR text:
- `NCMEC_USERNAME`, `NCMEC_PASSWORD` (NCMEC's Basic-auth pair);
- `NCMEC_REPORTER_NAME`, `NCMEC_REPORTER_EMAIL`, `NCMEC_REPORTER_PHONE`, `NCMEC_REPORTER_ADDRESS` (the
  `reportingPerson`, §4.5);

and the var `NCMEC_BASE_URL` (exttest vs prod; there's no default, so a missing value is "not configured"). If
**any** of the seven is missing or blank, intake and CONFIRM write `awaiting_credentials`, and the drain re-checks
every tick and promotes those rows to `pending` once all exist. That state **alarms** (§6). There is no placeholder
value in code; the merge condition is the deploy check (AC-C13).

### 4.5 Report contents

Built from what we hold. Every field below is checked against the live XSD (`GET /xsd`) once credentials exist,
and that check is a plan task.
- `incidentType` (child pornography / CSAM) and `incidentDateTime` (the upload time of that uploader's earliest
  matched media row).
- The reporting person: name, email, phone and address from the four `NCMEC_REPORTER_*` secrets (§4.4).
- The reported person (this report's uploader): `espIdentifier` (user id), `screenName` (handle), `profileUrl`,
  and email. **No IP data:** `clientIp()` (`apps/api/src/http/client-ip.ts:23`) exists, but only to key rate
  limiters (`search.ts:71`, `login.ts:236`, `signup.ts:158` and others); no migration stores an IP.
- The web page: the URL of every post that embeds one of this report's files.
- Files: this report's `ncmec_report_files` only, each with `fileViewedByEsp`: **`false` for a match-time report**,
  `true` when queued by a CONFIRM after a reveal, or by a moderator sighting.

**What a false positive means for the user.** A family photo that happens to match a hash is reported to NCMEC at
match ("Option B"), with `fileViewedByEsp = false`, which tells NCMEC no human here has looked. The user is
**reported, not punished**: the account is untouched (they can log in, post and comment), only the matched content
is quarantined, and they get no notice. If the moderator then clears it, the content comes back (§7.2).

## 5. Preservation (§2258A(h)) — starting at the match

| What | Where | Kept |
|---|---|---|
| The images | R2 `MEDIA_RESTRICTED` under a `csam` media hold from the match; after a CLEAR, an evidence copy (§7.2) | ≥ 1 year after the last report finished; no reaper, so in practice indefinitely |
| The report as sent | `ncmec_submissions.request_xml`, one row per send; UPDATE refused by trigger | ≥ 1 year (trigger floor), no reaper |
| The content (title, source) | `moderation_snapshots` (#126), written in intake step 6 | ≥ 1 year (`0021`'s trigger floor) |
| The account | a `csam` account hold from the match, so neither reaper deletes or anonymises it | indefinitely (§7.3) |
| The uploader's `media` rows | kept: the orphan reaper skips keys under a legal hold (new, below) | while the hold exists |
| Who did what | `moderation_actions` (incl. `csam_hold`, `csam_review`) + `csam_cases` | append-only |

⚠️ **Existing gap, found while revising:** `reapOrphanMedia` (`reap-orphan-media.ts:68-88`) deletes `media` rows
whose sha256 no post or snapshot references, with **no legal-hold check**. For a matched **orphan** upload (no
post), the uploader's `media` row, which is how intake and the drain know who uploaded it, would be deleted 24 h
after upload. (Its R2 delete targets only the public `MEDIA` bucket, `:118`, so the restricted object survives.)
The plan adds `AND NOT EXISTS (SELECT 1 FROM media_legal_holds h WHERE h.r2_key = m.r2_key)` to the orphan
selection.

Access is limited (§2258B(c)): held media is fetchable only through #61's two-person grant. Permanent destruction
on a law-enforcement request is **a manual runbook step** (§8), not app code.

## 6. Alarms — "never silent"

### 6.1 Conditions

The condition holds when **any** of these is true:
1. a report in `awaiting_credentials`;
2. a report in `failed`;
3. a report not `finished` within 6 h of being queued (`ncmec_reports.created_at`; under "Option B" that is the
   match, for a CONFIRM-queued report it is the confirmation);
4. a non-empty `abandoned_report_ids` on a still-unfinished report;
5. a report whose `last_response_code` is `2000` or `3100`. This one is **immediate**: credentials NCMEC rejects
   cannot heal themselves;
6. **new: an undecided case** (`review_outcome IS NULL`) older than **N hours**, where N = 0 for a `known_hash` or
   `classifier` case (it alarms from the match) and the case is **OVERDUE** once older than
   `CSAM_REVIEW_TARGET_HOURS`.

### 6.2 Review target and escalation — ⚠️ PROPOSALS for CireSnave (board item 125)

These are **draft defaults awaiting CireSnave's OK**, kept as named constants in `config.ts` so the answer is one
reviewed line:

| Constant | Draft default | Meaning |
|---|---|---|
| `CSAM_REVIEW_TARGET_HOURS` | `24` | A decision is expected within 24 h of the match. |
| `CSAM_ALARM_REPEAT_HOURS` | `4` | A `known_hash` case's URGENT email repeats every 4 h while undecided. |
| `CSAM_CLASSIFIER_ALARM_REPEAT_HOURS` | `24` | A `classifier` case (lower confidence) repeats daily instead. **Proposal**: a different priority for kind (b). |
| `CSAM_OVERDUE_SUBJECT_PREFIX` | `"OVERDUE"` | Prefixed to the subject once a case passes the target. |

- **At the match:** an URGENT email to `CSAM_ALARM_EMAIL` (subject `"URGENT: CSAM match needs review"`; a classifier
  case: `"CSAM review needed"`), with the case link and nothing else: no image, no hash, no handle.
- **While undecided:** the same email every `CSAM_ALARM_REPEAT_HOURS`, driven by `csam_cases.alarm_next_at` on the
  `*/2` tick, so a lost send is retried within 2 minutes. After `CSAM_REVIEW_TARGET_HOURS` the subject starts with
  `"OVERDUE"`.
- **Every tick:** the admin banner and an `ncmec ALARM` log line, for as long as any case is undecided.
- **Nothing auto-bans or auto-clears on timeout.** An overdue case stays quarantined and keeps alarming until a
  human decides.

### 6.3 Surfaces

- **Admin banner:** every `/admin/*` page shows a red banner with the counts and a link, from
  `GET /admin/csam/alarm`.
- **Email:** to `CSAM_ALARM_EMAIL`, a Worker secret **supplied by the operator as a secret**. Conditions 1–5: the
  daily `0 14 * * *` tick emails while the condition holds, with no dedup suppression, and conditions 2 and 5 also
  email on the tick that first raises them. Condition 6: §6.2's cadence.
- **Log:** an `ncmec ALARM` line every drain tick while anything holds.

## 7. Review

`/admin/csam` lists cases, **undecided first** (`urgent`, then `high`, oldest first), then the rest newest first,
with kind, source, age against the target, NCMEC status and report id, and any re-upload attempts. Previews are
**blurred**, and **Reveal** is an explicit control. Revealing sets `revealed_at`, logs `media_access`, and the image
itself is fetched only through the two-person grant (§3.3 step 5). It does not change an already-sent report.

### 7.1 CONFIRM

§3.5. Any Access admin can confirm, after revealing every file.

### 7.2 CLEAR (false positive)

Under ⚠️ **two-person rule (proposal)** for a `known_hash` case: one admin records "clear" with a statement and a
**different** admin (`sameAdminHand`, as the media grant uses) approves it, because a clear puts a file that matched
a CSAM hash list back on the public internet. A `classifier` case clears with one admin.

The clear transaction:
1. **Evidence copy first (before the transaction):** copy each file's object inside `MEDIA_RESTRICTED` to
   `evidence/csam/<caseId>/<sha256>.webp`, verify it with a `head`, and record it in `csam_case_files.evidence_key`.
   Under "Option B" the file was reported, and §2258A(h)(1) asks us to preserve it for a year whatever our review
   found; the serving copy is about to go public again.
2. In one transaction: set `review_outcome = 'false_positive'` with the statement and both hands; write
   `csam_review`; **release the media hold** on each serving key by moving its `media_legal_holds` row into a new
   `media_legal_hold_releases` archive table (with the case, both hands and the time) and deleting it, logged as
   `csam_clear_release`. Deleting rather than adding a `released_at` column keeps every existing reader
   (`isKeyLegallyHeld`, `legallyHeldKeys`, the `ON CONFLICT (r2_key)` insert) correct without a change, and lets a
   later case re-impose a hold. A held evidence key is never released.
3. **Restore the content:** `applyDecisionInTx(c, { decision: "restore", … })` for each post the case hid
   (`csam_case_targets`).
4. **Reports:** a report that has **not** been submitted (`awaiting_credentials`, `pending`, `failed`) becomes
   `withdrawn` and is never sent. A `submitted`, unfinished one becomes `retract_pending`, and the drain calls
   `/retract` (allowed before finish). A `finished` report is left as it is, and its record is kept.
5. COMMIT. After commit: `afterContentDecision` with `decision: "restore"` and **no** `legalHold`, which moves each
   key back to the public bucket (`visibility-hook.ts:64-65`) now that it is no longer held. Account untouched:
   nothing was barred. The alarm stops.

**Audit:** the case row, both hands, the statement, the `csam_review` and `csam_clear_release` actions, the
archived hold, every `ncmec_submissions` row and the report rows (with their final status) all stay.

**Suppression:** §3.6. The cleared file does not re-alarm on the same or a weaker signal.

**Follow-up to NCMEC after a finished report.** NCMEC's ISP Web Services has **no** amend, supplement or withdraw
call for a finished report: `/retract` works only before `/finish`, and after it "the report cannot be cancelled"
(§0, read 2026-10-04). The only cross-report link, `<priorCTReports>`, sits inside a new report about a person, and
filing a new CSAM report to say "this was not CSAM" would be wrong.
- **Our reading:** the honest path is an out-of-band message to NCMEC's CyberTipline, through the contact channel
  NCMEC gives the ESP at enrolment, naming the report id and stating that our human review found no violation. The
  runbook (§8) carries the step; the case records when it was sent and by whom.
- ⚠️ **Legal uncertainty:** whether any follow-up is required, and whether withdrawing a not-yet-submitted
  known-hash report after a human CLEAR is right, are **unsettled**. The reading here is that once a human has
  determined there is no violation, sending a still-unsent report would knowingly report what we believe false,
  which §2258B(b)'s "intentional misconduct" exception makes the riskier side. This is a best safe guess, not
  advice, and it is CireSnave's to overrule.

### 7.3 What a CLEAR does not undo

- The `csam` **account hold** stays: app code cannot release it (`account-holds.ts:162`), and a report may have been
  filed. The user notices nothing unless they ask to delete their account, which then waits. ⚠️ **Needs a ruling:**
  should a cleared case's account hold become releasable (two hands, after the year)? Not built here.
- A `finished` NCMEC report stays filed (above).
- Cloudflare's own edge block, if any, is lifted by hand in the dashboard (runbook).

Who can review: any Access admin. Access to the **images** keeps #61's two-person rule.

## 8. Out of scope (stated, not forgotten)

- **Email Worker intake (v2)**: after capturing one real Cloudflare notification.
- **Our own scanning** (R2's ruling): designed in a separate document. It enters through §3.1 (b).
- **A tool for destruction on law-enforcement request**: a runbook entry in `docs/runbooks/csam.md`, which this
  work creates, covering who, how, and the two-person rule.
- **Telling any user anything** (A3, and R1's quarantine): no notice at match, at confirm or at clear.
- **Lifting Cloudflare's own block**: a dashboard-only step (Security Center → Blocked Content), in the runbook.

## 9. Acceptance conditions (merge conditions for the implementation PRs)

| # | Condition |
|---|---|
| AC-C1 | After a match intake, the content is not publicly reachable: the public routes 404, and the media is out of the public bucket. Tested through the real public endpoints. |
| AC-C2 | For a **known-hash** match, no human action stands between intake and `submit`: the drain alone takes the match-time report to `finished` against the NCMEC test double. |
| AC-C3 | A report whose NCMEC deletion window has passed (or a `5001`) is resubmitted, with the old id kept in `abandoned_report_ids`. Shown to fail with the resubmit removed. |
| AC-C4 | Each of §6's six alarm conditions produces the banner and the log line. Conditions 2 and 5 also send the immediate email. Each is shown to fail when its condition is removed. |
| AC-C5 | The response byte cap fires before the parser, and a test of an oversized body fails without the cap. |
| AC-C6 | `CSAM_BAR_UNREVIEWED_MATCH = false` and `CSAM_REPORT_AT_MATCH = true`, **both** equal to CireSnave's quoted words (R1, and "Option B."), quoted in the code and the PR. Both branches of each constant are tested. |
| AC-C7 | No email is sent to the uploader or author by any CSAM path (A3). |
| AC-C8 | An end-to-end run against **exttest** (`exttest.cybertip.org`) reaches `finished`, once credentials exist. **Nothing is filed to production, and APP.live does not flip, until this is shown.** |
| AC-C9 | After a match intake, every held image has left the public bucket, **including an orphan upload with no embedding post**. Shown to fail when the post-commit `legalHold` argument is dropped (§3.3). |
| AC-C10 | A second intake of a suppressed key (§3.6) files nothing new (no new case, report, hold or alarm). Shown to fail without the uniqueness/lock check. A classifier-cleared key matched by a known hash **does** open a case. |
| AC-C11 | In a multi-uploader case, each NCMEC report carries only the files that uploader's own media rows hold (R3). |
| AC-C12 | The `fast-xml-parser` characterisation test (§4.3) passes against the exact version pinned in `apps/api/package.json`. |
| AC-C13 | Deployment: the seven NCMEC secrets/vars and `CSAM_ALARM_EMAIL` are set as Worker secrets by the operator before the first deploy that drains. No real contact value appears anywhere in the repo, its history or the PR text. |
| AC-C14 | **Quarantine:** an unreviewed match (`known_hash` or `classifier`) **never bars the account**: after intake the uploader's `disabled_at`, `disabled_reason` and `suspended_until` are unchanged and the uploader can log in and post. The matched content is unfetchable except through `GET /media/restricted/:sha256` with an approved two-person grant. A **classifier** case queues **no** report under either value of `CSAM_REPORT_AT_MATCH`. |
| AC-C15 | **Clear:** a CLEAR restores the posts, moves the media back to the public bucket, keeps an evidence copy and the archived hold, withdraws an unsubmitted report (no NCMEC call), retracts a submitted unfinished one, leaves a finished one and its record intact, and writes the audit rows. Re-detecting the cleared file files nothing (AC-C10). |
| AC-C16 | **Escalation:** an undecided case alarms at the match, re-emails every `CSAM_ALARM_REPEAT_HOURS`, gains the `OVERDUE` subject after `CSAM_REVIEW_TARGET_HOURS`, and is never barred or cleared by any timer. Shown with a clock passed to the tick. |
| AC-C17 | **Re-upload:** uploading the bytes of a held file is refused before any R2 write, and a `csam` hold logs the attempt (§3.7). |

## 10. Dependencies and order

Plan A (#132) and plan B (#144: `applyDecisionInTx`, `afterContentDecision`) are merged; so are #126 (snapshots,
`0021`), the account legal hold (#139: `imposeAccountHoldInTx`, holds gate the reapers, `0022`), #141 (reserved-email
HMAC under `RESERVED_EMAIL_KEY`, `0023`) and #145 (`0025`). The next migration is **`0026`**. This work's own
prerequisites, the first tasks of its plan: the `applyAccountActionInTx` split, the shared media-key helper, the
reaper's legal-hold exclusion, the upload route's held-key refusal, and the `fast-xml-parser` dependency. Plan C
(DSA) is independent.

Building and shipping this needs: the NCMEC exttest and production credentials, and the reporter and alarm secrets
(operator-supplied); CireSnave's OK, or changes, on §6.2's proposals, §7.2's two-person clear, and §7.3's
account-hold question. The implementation PRs wait for the NCMEC credentials.
