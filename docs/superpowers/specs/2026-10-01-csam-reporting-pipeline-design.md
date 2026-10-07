# CSAM Detection → NCMEC Reporting Pipeline — Design

**Status:** Revision 3 (2026-10-06), for PM review, then the implementation plan. Part of #114 (part 2). This is the
design `2026-09-06-m4-moderation-queue-design.md` §1 points to as "`2026-09-06-csam-reporting-pipeline-design.md` when written".
Revision 1 applies CireSnave's R1 ruling (quarantine and review, no bar on an unreviewed match) and his report-timing
ruling ("Option B"), and brings every code reference up to `origin/main` at `9a76b6f` (0.1.4, last migration `0025`).
Revision 2 (same day) answers an audit of revision 1: only matched keys are quarantined, a CLEAR restores and releases
only what the case itself hid and held, classifier cases take the account hold at CONFIRM, and three alarm
conditions and a re-upload question were added. A re-audit's follow-ups are folded into revision 2: "viewed" counts
only a served fetch under a grant the case asked for, condition 8 reads the newest move row, disposition precedence,
a sighting always hides its own subject, "decided" is defined, and a CLEAR never restores content another case holds.
Revision 3 (2026-10-06, checked against `origin/main` at `f3533af`) makes three changes:
- **Preservation** (§5): it never ends earlier than 1 year after a report's submission to NCMEC, whatever a CLEAR or a
  retraction does (18 U.S.C. §2258A(h), quoted in §0).
- **Hash-matching service A** ("HMS-A", §11): the terms of the scanning service CireSnave registered for are
  encoded, under a neutral alias because this repo is public, including a removal-request intake (§3.1 d).
- **CireSnave's rulings** on the draft defaults and proposals b–e (§0) replace every "awaiting his OK" marker.

Since `f3533af` (#147), main also closes the two gaps that revision 2 found (§3.7, §5).
**Author:** Community controller agent, 2026-10-01; revised 2026-10-04 and 2026-10-06.
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
- **Draft defaults and proposals b–e (relayed by the PM, 2026-10-05):** *"I agree with the draft defaults. I agree
  with proposals b, c, d, and e."* These are now **DECIDED**:
  - **the draft defaults** (§6.2): `CSAM_REVIEW_TARGET_HOURS = 24`, `CSAM_ALARM_REPEAT_HOURS = 4`, a case is
    OVERDUE after 24 h, and nothing auto-bans or auto-clears;
  - **(b)** clearing a known-hash case takes two people (§7.2);
  - **(c)** a CLEAR cancels an unsent report and retracts a sent but unfinished one. For a finished report, the
    follow-up to NCMEC is out of band, which is a legal uncertainty (§7.2). Item 1 of this revision constrains (c):
    **preservation is never shortened** (§5);
  - **(d)** on a two-person CLEAR, the account hold the match imposed is released. The evidence stays preserved
    separately for the full period (§5, §7.2);
  - **(e)** a classifier case's alarm repeats every 24 h (§6.2).
  - **(f)**, the number of Access admins, is **still pending**. It stays a stated launch precondition (below).
- **Preservation (relayed by the PM with the revision-3 brief):** a CLEAR may withdraw what we asserted, but it must
  never shorten preservation. CireSnave, verbatim: *"There is no attorney nor can I afford one so proceed with best
  safe guesses."* §5 is that best safe guess.
- **Scanning service:** CireSnave registered for **hash-matching service A** (HMS-A; §11 explains the alias). Its
  credentials are set as secrets on the api Worker, named `HMS_A_USERNAME` and `HMS_A_PASSWORD` here. On sending
  images, verbatim: *"I'm fine with sending images to remote servers to be checked."* §11 encodes its terms.
- **PM rulings on revision 3's open points (2026-10-06; CireSnave may veto them on board 133):**
  - **(B) vendor names:** the scanning provider is named only by the alias HMS-A in this public repo (§11);
  - **removal requests** take a two-person CLEAR (§7.2);
  - **fail-closed upload** supersedes the options doc's "don't block at launch" note (§11.1);
  - **re-upload by another account** (§3.7): a **different** account uploading already-reported content gets its
    **own** report, at match (Option B); the **same** account repeating an upload is recorded and alarms, with no new
    report;
  - **destruction:** once a **cleared** case's preservation period ends, its evidence is **destroyed** unless a legal
    hold applies (§5 P7);
  - **NIST storage:** the plan gains a task for §2258A(h)(6) secure storage (§5 P8);
  - **each send** counts as its own submission for the preservation period (§5 P1).

**PM rulings (2026-10-01), still standing:** dual intake (A1); images blurred by default with an explicit Reveal
(A2); no notice to a terminated user (A3); outbox + cron (approach 2); manual-paste intake now and an Email Worker
later; every uploader of a matched image is reported, and on CONFIRM barred, but someone who only embeds it is not
(R3).

**The statute, quoted exactly.** Source: the official United States Code, **2024 Edition**, published by the GPO on
govinfo, read 2026-10-06:
<https://www.govinfo.gov/content/pkg/USCODE-2024-title18/html/USCODE-2024-title18-partI-chap110-sec2258A.htm>
(and `…-sec2258B.htm` for §2258B). No 2025 edition of the section was on govinfo that day: the same URL with
`USCODE-2025` answered a redirect, not the page. Where a quote runs across the Code's numbered paragraphs, the
paragraph breaks are joined with a space; the words are unchanged. The 2024 edition's notes record that Pub. L. 118–59 (the REPORT
Act, May 7, 2024) "substituted "1 year" for "90 days"" in (h)(1), and added (h)(5) and (h)(6).
- **§2258A(a)(1)(A)(i):** a provider "shall, as soon as reasonably possible after obtaining actual knowledge of any
  facts or circumstances described in paragraph (2)(A), take the actions described in subparagraph (B)".
- **§2258A(e):** "A provider that knowingly and willfully fails to make a report required under subsection (a)(1)
  shall be fined— (1) in the case of an initial knowing and willful failure to make a report, not more than $850,000
  in the case of a provider with not less than 100,000,000 monthly active users or $600,000 in the case of a provider
  with less than 100,000,000 monthly active users; and (2) in the case of any second or subsequent knowing and
  willful failure to make a report, not more than $1,000,000 in the case of a provider with not less than
  100,000,000 monthly active users or $850,000 in the case of a provider with less than 100,000,000 monthly active
  users."
- **§2258A(f):** "Nothing in this section shall be construed to require a provider to— (1) monitor any user,
  subscriber, or customer of that provider; (2) monitor the content of any communication of any person described in
  paragraph (1); or (3) affirmatively search, screen, or scan for facts or circumstances described in sections (a)
  and (b)." We scan anyway, by CireSnave's choice (R2), not because (f) requires it.
- **§2258A(h)(1):** "For the purposes of this section, a completed submission by a provider of a report to the
  CyberTipline under subsection (a)(1) shall be treated as a request to preserve the contents provided in the report
  for 1 year after the submission to the CyberTipline."
- **§2258A(h)(2):** "Pursuant to paragraph (1), a provider shall preserve any visual depictions, data, or other
  digital files that are reasonably accessible and may provide context or additional information about the reported
  material or person."
- **§2258A(h)(3):** "A provider preserving materials under this section shall maintain the materials in a secure
  location and take appropriate steps to limit access by agents or employees of the service to the materials to that
  access necessary to comply with the requirements of this subsection."
- **§2258A(h)(5):** a provider "may voluntarily preserve the contents provided in the report (including any
  comingled content described in paragraph (2)) for longer than 1 year after the submission to the CyberTipline for
  the purpose of reducing the proliferation of online child sexual exploitation or preventing the online sexual
  exploitation of children."
- **§2258A(h)(6):** "Not later than 1 year after the date of enactment of this paragraph, a provider of a report to
  the CyberTipline under subsection (a)(1) shall preserve materials under this subsection in a manner that is
  consistent with the most recent version of the Cybersecurity Framework developed by the National Institute of
  Standards and Technology, or any successor thereto." The date of enactment is May 7, 2024, so this already applies.
- **§2258B(c):** "A provider and domain name registrar shall— (1) minimize the number of employees that are provided
  access to any visual depiction provided under section 2258A or 2258C; and (2) ensure that any such visual depiction
  is permanently destroyed, upon a request from a law enforcement agency to destroy the visual depiction."

**Other facts (primary sources, research notes):**
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

⚠️ **Precondition for the PM:** both two-person rules here (clearing a known-hash case, §7.2, and fetching held
media at all, `media-restricted.ts:116-122`) need **at least two Access admins**. With only one, a known-hash false
positive stays quarantined forever, and no file can be viewed, so no case can be confirmed or cleared (§3.5 step 2).
Two admins must exist before launch. This is **ruling (f), still pending**: until CireSnave answers, it stays a stated
launch precondition. The two-person CLEAR of a `removal_request` case (§7.2) needs the same two admins.

---

## 1. What success looks like

From the moment a detection or a human sighting enters the system:
- the matched content stops being served **at once** (quarantine), and only the legal-hold audience can fetch it;
- the evidence is preserved from that moment, and for at least 1 year after the last submission to NCMEC, even if
  the case is later cleared or the report retracted (§5);
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
HMS-A removal request (monitored contact, pasted) ──┤   removal request (§11.4)
Moderator sees CSAM in the review queue ────────────┤   moderator sighting
                                                    ▼
                         INTAKE (one Postgres transaction)
   quarantine: csam media hold on each MATCHED key · hide every post/comment embedding it · snapshots ·
   known-hash: csam account hold on each uploader (access untouched) · csam_cases row (alarm_next_at=now) ·
   ncmec_reports rows 'pending' — known-hash only, CSAM_REPORT_AT_MATCH
   [moderator sighting only: the CONFIRM transaction runs here too]
                                                    │ commit
   after commit: matched keys → MEDIA_RESTRICTED · content purge (no legalHold) · URGENT email (best effort)
                                                    ▼
        */2 cron: NCMEC DRAIN (submit → upload → fileinfo → finish) · CASE ALARMS (URGENT every 4 h)
                                                    ▼
                         REVIEW (a human, target 24 h — decided)
             CONFIRM: terminate each uploader · queue any report not yet queued · keep holds
             CLEAR:   two people for known-hash · restore content · release the case's serving-key holds and
                      its account holds · evidence copy stays held ≥ 1 year after submission (§5) ·
                      cancel an unsent report, retract an unfinished one · audit
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
| `classifier` | `self_scan` | Low: an ML "possibly CSAM" score. CireSnave's newborn example is this kind. | **Never**, under either constant value | `high` (§6.2) |
| `removal_request` | `hms_a_removal_request` | Medium: HMS-A asked us to remove it (§11.4). A request is not a CyberTipline report by itself | **Never** at intake; a moderator decides, and CONFIRM files | `urgent` |
| `moderator_sighting` | `moderator` | A human looked | Yes, at intake: the sighting **is** the confirmation (§3.5) | — (decided at intake) |

A CHECK pins the pairs: `cloudflare_match` → `known_hash`; `self_scan` → `known_hash` or `classifier`;
`hms_a_removal_request` → `removal_request`; `moderator` → `moderator_sighting`. Both machine kinds and a removal
request enter **the same quarantine and review pipeline**; they differ only in the report timing and the alarm
cadence.

- **(a) Cloudflare match.** Admin route `POST /admin/csam/matches`, body `{ lines: string[] }`: the matched file
  paths copied from Cloudflare's email (e.g. `https://cdn.thinkersjournal.com/media/post/<sha256>.webp`) or bare
  sha256 digests. Each is normalised to an R2 key with `r2KeyForSha256` (`apps/api/src/media/key-pattern.ts:12`).
  Anything that doesn't resolve is reported back to the moderator by input line, never silently dropped.
- **(b) Self-scan.** The separate scanning design calls the same intake function, `runIntake`, with
  `source = 'self_scan'`, `kind = 'known_hash'` for a hash-list match or `kind = 'classifier'` for a classifier
  flag, and a system actor (`system:self-scan`). Nothing in this design depends on how the scanner works.
- **(c) Human-spotted.** Admin route `POST /admin/csam/cases`, body `{ subject: "post" | "comment", subjectId }`,
  reached from a "Report as CSAM" control on the review queue and the admin account page. Its keys are the media the
  post or comment embeds (`mediaKeysReferencedBy`, `reachability.ts:47-60`).
- **(d) HMS-A removal request** (§11.4). Admin route `POST /admin/csam/removal-requests`, body `{ lines: string[],
  hmsAReference: string, receivedAt: string }`: the media paths or sha256 digests the request names, HMS-A's own
  reference for it, and when it arrived at the monitored contact. Lines are parsed exactly like (a), and each one is
  recorded in `csam_removal_requests` against the case it opens or joins. It opens a priority case with the same
  alarm clock as a known-hash match (§6.2), and it files **nothing** at intake. If the request names a page, not a
  file, the moderator pastes the media paths that page embeds.
- **(v2, later, separate PR) Email Worker** for (a). It's built only after one real Cloudflare notification email
  has been captured, since the format is unverified.

`viewed_by_esp` (NCMEC's `fileViewedByEsp`: "the reporting company viewed the entire contents of the file") is
fixed **per report file, when the report is queued**, from evidence of a whole-file view, never from a button press:
- `true` when the file was **served** under a two-person grant **that this case asked for**; or when a moderator
  **attested** seeing it in a sighting (§3.1 c, `csam_case_files.seen_by`);
- `false` otherwise, which includes every report queued at match.

"Served under this case's grant" is defined without any clock window:
- **The grant belongs to the case file.** Reveal (§7) creates the `media_access_requests` row itself, with a new
  nullable `case_file_id` column (bare uuid, migration `0026`) naming the case file; a second admin approves it on
  the existing media-access page.
- **The log row means "served", not "asked".** Today `media-restricted.ts:126-133` writes the `media_access` row
  **before** `serveObject` looks the object up (`:55-57`), so a fetch that 404s (a failed move, a missing object)
  is logged exactly like a real view. The plan changes the legal-hold branch to `get` the object first, return the
  404 with **no** log row when it is missing, and only then write `media_access` with `internal_note = <grant id>`
  and stream the body it already holds.
- **Viewed** = `seen_by IS NOT NULL` or `EXISTS (media_access_requests r JOIN moderation_actions a ON a.action =
  'media_access' AND a.subject_label = r.r2_key AND a.internal_note = r.id::text WHERE r.case_file_id = f.id)`.
  Keying on the grant replaces the earlier "after `created_at`" window, which was wrong: `created_at` is the intake
  transaction's start time, not its commit.

`revealed_at` (§7) records only that a reviewer pressed Reveal; it never sets `viewed_by_esp`.

### 3.2 Who is affected, and the shared key helper

For each matched key:
- **uploaders**: every `media.owner_id` with that `r2_key`. Media is content-addressed, so several users can hold
  the same object (R3).
- **embedding content**: every **post** whose `markdown_source` and every **comment** whose `body_markdown`
  references the key. Comments do carry media: `reachability.ts:36-39` and `:52-55` treat a comment's
  `body_markdown` exactly like a post's source, and comments render images.

**Policy for embedding content:** every embedding post **and comment** is quarantined the same way (snapshot,
`keep_hidden`, a case target, restored by a CLEAR). Only **uploaders** are reported and, on CONFIRM, barred (R3); an
author who only embeds someone else's upload is neither reported nor barred.

**Prerequisite (the plan's first task): one media-key helper.** Copies of the `media/post/<sha256>.webp` SQL
pattern at `9a76b6f`:
- `key-pattern.ts:9`'s `MEDIA_KEY_SQL_PATTERN`, exported but imported by nothing, although its comment claims
  `reap-orphan-media.ts` uses it;
- `reachability.ts:16`'s private `MEDIA_KEY_REGEX_SQL`;
- `reap-orphan-media.ts:71` and `:77`'s two inline literals (posts, and `moderation_snapshots` since #126).

All of them move onto the one export, and the CSAM code uses only that export, in both directions: key → posts and
comments, and post → keys. Input parsing for (a): each line is either a bare 64-hex sha256 or any URL/path whose path
ends in `media/post/<sha256>.webp`. The domain is not checked.

### 3.3 The intake transaction (quarantine)

**New shared primitive (the plan's second task):** split plan A's `applyAccountAction`
(`apps/api/src/moderation/account-actions.ts:66`) into a transaction-neutral `applyAccountActionInTx(c, input)`
plus a wrapper, **exactly as** plan B split `applyDecisionInTx` (`decide.ts:90`) out of `applyDecision`
(`decide.ts:181`). CONFIRM (§3.5) calls it, and so would intake's bar branch if `CSAM_BAR_UNREVIEWED_MATCH` were
ever true (§3.4).

**New `moderation_actions` kinds:** `csam_hold`, `csam_review` and `csam_clear_release` (a migration extends the
action CHECK; the latest list is `0022_account_legal_holds.sql:70`). Each case writes exactly one `csam_hold`.
Every legal hold the case imposes and every `csam_cases` row references it.

**Sequence:**

0. **Resolve, read-only, before the transaction:** each key's disposition (§3.6), then the uploaders and the
   embedding posts and comments of the keys that open a case.
1. Open the transaction (`BEGIN_BOUNDED_TX`). Take `pg_advisory_xact_lock(<CSAM_INTAKE lock id>)`. Intake is
   low-volume, so serialising every intake is cheap and closes every intake-vs-intake race.
2. **Disposition, inside the lock (§3.6):** drop every `suppress`ed key; for a sighting, `attach` keys join their
   open case (no new case row). ⚠️ **A sighting always hides its own subject:** on `attach` **and** on `suppress`,
   the moderator's post or comment gets step 6's treatment (snapshot, `keep_hidden`, and a target on the existing
   case if `wasHidden === false`). If nothing remains to open, apply those, COMMIT, and return the existing case(s).
   Nothing is re-filed, and nothing re-alarms.
3. Re-resolve uploaders and embedding content for the remaining keys, inside the transaction. This is the
   authoritative set. A digest with **no `media` row** opens no case: it is recorded in `csam_unmatched_digests`,
   which alarms (§6 condition 7), because its evidence may already be gone. **Amended 2026-10-07:** an upload-time
   match is the one exception. It never had a `media` row, and it opens a case on its evidence file through
   `runUploadIntake`, with the uploader recorded on the case file (`2026-10-07-upload-scan-design.md` §5.2–§5.3).
4. Write the `csam_hold` action row (`actor_admin` = the moderator or the system actor; `subject_user_id` = the
   first uploader, or null; `reason` = fixed internal text naming the case), then the `csam_cases` row
   (`source`, `kind`, `priority`, `alarm_next_at = now()`; `priority` is `urgent` for `known_hash` and
   `removal_request`, `high` for `classifier`; a sighting's case is `priority = 'decided'` and gets no alarm,
   because it is confirmed in this transaction). A removal request also writes its `csam_removal_requests` rows.
5. **Quarantine the matched media, and only that.** For each remaining key: `imposeLegalHold(c, { r2Key, category:
   "csam", imposedBy, moderationActionId: <the csam_hold id> })` (`legal-hold.ts:19`). This is the existing #61
   restricted path, not a new one: a held key is served **only** by `GET /media/restricted/:sha256`, or, for a
   case file, by `GET /media/restricted/case-file/:caseFileId` (amended 2026-10-07, `2026-10-07-upload-scan-design.md` §5.6 Task 9), to an
   Access admin holding an approved two-person grant (`media_access_requests`; `media-restricted.ts:81-135`), and
   every other caller gets a 404. If the key already had a hold (a `dmca` or `other` one), the insert is a no-op
   (`ON CONFLICT (r2_key) DO NOTHING`, `legal-hold.ts:31`): the key is already restricted, and that hold is not the
   case's to release (§7.2).
6. **Quarantine the content.** For each embedding post or comment, in id order: lock it (`SELECT … FOR UPDATE`;
   gone → skip it), write a `moderation_snapshots` row (posts: `(post_id, author_id, title, body_markdown)`, the
   shape `posts.ts:515` uses; comments: `(comment_id, author_id, body_markdown)`, `comments.ts:292`), with the new
   nullable `csam_case_id` column set to the case, so §5's preservation guard covers it; then call
   `applyDecisionInTx(c, { subject, subjectId, decision: "keep_hidden", reason: <fixed text>, actorAdmin })`. A
   `null` result is skipped, with nothing recorded for it: its `UPDATE … FROM users` (and, for a comment, `posts`)
   join (`decide.ts:94-117`) found no row, which with the item already locked means its author's or parent post's
   row is gone. Record a
   `csam_case_targets` row **only when `result.wasHidden === false`**: content that was already hidden before the
   match was hidden for another reason, and a CLEAR must not un-hide it.
   `keep_hidden`, not `remove`: R1 says not to act as if the determination had been made, and both set `hidden_at`
   (`decide.ts:76-80`). **No author notice** (nothing is minted or sent from intake).
   ⚠️ `applyDecisionInTx` also resolves every confirmed open DSA notice on the content (`decide.ts:144`), and
   `afterContentDecision` emails those **reporters** the `reason` verbatim (`after-content-decision.ts:59-64`). The
   fixed `reason` is therefore reporter-safe text ("Hidden pending a child-safety review"), and never names a hash,
   a case or the uploader.
7. **Bar branch:** for each uploader for whom `barsAtMatch(kind, CSAM_BAR_UNREVIEWED_MATCH)` is true,
   `applyAccountActionInTx(c, { kind: "terminate", … })`. `barsAtMatch` is a pure helper: true only for
   `known_hash` **and** a true constant. With R1's `false` it is never true, so no machine detection bars anyone;
   the branch exists so the constant is read in exactly one place and both values are tested.
7a. **Account hold, `known_hash` only:** for every uploader in step 3's set, in id order (lock order):
    `imposeAccountHoldInTx(c, { userId, category: "csam", imposedBy, reason: <case text>, moderationActionId:
    holdActionId })` (`account-holds.ts:49`). **A hold blocks deletion, not access** (`anonymise-accounts.ts:107,226`
    and `reap-unverified.ts:69` skip held users; nothing on the login or session path reads `account_legal_holds`).
    It is imposed **at match for a known-hash case**, because under "Option B" that case is reported at once; a
    user quietly deleting their account between the match and the review would otherwise take the report's subject
    data with them. ⚠️ **Legal uncertainty** (no attorney): this design reads §2258A(h)(2)'s "data … that may
    provide context" as reaching the reported person's account record; that reading is a best safe guess.
    A **classifier** or **removal-request** case takes **no** account hold at match: it is not reported at match,
    and a classifier flag is the newborn-photo kind CireSnave named. It takes the hold at CONFIRM (§3.5). The only
    app path that releases a `csam` account hold is a CLEAR (ruling d, §7.2); the admin release route still refuses
    one (`releaseAccountHold`, `account-holds.ts:162`).
8. `INSERT csam_case_files` (case id, key, sha256, kind). **If `queuesReportAtMatch(kind, CSAM_REPORT_AT_MATCH)`**
   (true only for `known_hash` with the constant true): for each uploader, `INSERT ncmec_reports` (`pending`, or
   `awaiting_credentials` per §4.4) plus one `ncmec_report_files` row (`viewed_by_esp` per §3.1, so `false`) for
   each of the case's files that uploader's own `media` row holds (R3). For `classifier` and `removal_request`,
   nothing is queued, under either constant value.
8a. **A moderator sighting** calls `confirmCaseInTx` (§3.5) here, inside this transaction, with the files marked
    `seen_by`/`seen_at` and `revealed_at` set, because the moderator saw it.
9. COMMIT.

**After commit**, outside the transaction:
- for each matched key, `enqueueAndAttemptMove(env, ctx, r2Key, "to_restricted")` (`moves.ts:41`), the same call
  `visibility-hook.ts:52` makes on its legal-hold branch. This is what moves the matched image, whether or not any
  post embeds it.
- for each content item step 6 hid, `afterContentDecision(env, ctx, { subject, decision: "keep_hidden", reason,
  result })` **without `legalHold`**. ⚠️ Passing `legalHold` would make `applyMediaVisibilityChange` impose a
  `csam` hold and a `to_restricted` move on **every** key the post or comment embeds (`visibility-hook.ts:34-53`),
  innocent co-embedded images included, and a CLEAR releases only the case's keys, so those would stay restricted
  for good. Without it, the hook skips each matched key because it is already held (`:56-57`), and every other key
  takes the normal reachability path (`:59-63`): it moves only if no visible content still uses it.
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

Each constant is read through one pure helper, which intake calls:
- `barsAtMatch(kind, CSAM_BAR_UNREVIEWED_MATCH)`: true only for `known_hash` with the constant true. With R1's
  `false`, no machine detection bars anyone; bars happen in CONFIRM (§3.5).
- `queuesReportAtMatch(kind, CSAM_REPORT_AT_MATCH)`: true only for `known_hash` with the constant true. With it
  `false` (the alternative CireSnave did not choose), a known-hash report would be queued in CONFIRM, like a
  classifier report. A classifier flag is false under both values.

Both values of **both** constants are tested, through the helpers and through an intake run with the value
overridden by a test-only hook, so a future change is one reviewed line. **The implementation PR does not merge
until both constants equal CireSnave's quoted words** (AC-C6).

### 3.5 CONFIRM — "actual knowledge"

```ts
export interface ConfirmCaseInput {
  readonly caseId: string;
  /** The CONFIRM form's text, or the sighting route's required `statement`. */
  readonly statement: string;
  readonly actorAdmin: string;
  /** True only from intake's sighting path, whose files carry `seen_by`. */
  readonly sighting: boolean;
}
export type ConfirmCaseOutcome =
  | { readonly kind: "confirmed"; readonly terminated: readonly string[]; readonly reportsQueued: number }
  | { readonly kind: "already_decided" }
  | { readonly kind: "not_viewed"; readonly caseFileIds: readonly string[] }
  | { readonly kind: "not_found" };
export function confirmCaseInTx(c: Client, input: ConfirmCaseInput): Promise<ConfirmCaseOutcome>;
```

A case is **decided** exactly when `review_outcome IS NOT NULL`; `priority = 'decided'` mirrors it for sorting
and is never tested on its own. `confirmCaseInTx` is transaction-neutral, like `applyDecisionInTx`. The CONFIRM
route wraps it in its own transaction; a moderator sighting calls it inside intake's (§3.3 step 8a), passing the
sighting route's required `statement`. It:
1. locks the case row (`FOR UPDATE`) and returns `already_decided` when `review_outcome IS NOT NULL`;
2. requires every case file to be **viewed** (§3.1: served under this case's grant, or an attested sighting): a
   decision on a file nobody looked at is not a review;
3. for each uploader: `applyAccountActionInTx(c, { kind: "terminate", … })` (plan A's terminate,
   `account-actions.ts:63`: `disabled_at = COALESCE(u.disabled_at, now())`, `disabled_reason = 'terminate'`, and
   `already_disabled` never applies to a terminate, `:82`). **A terminate is never appealable**
   (`routes/appeals.ts:54-60`: a `user_terminate` action has no appeal target; `moderation/appeals.ts:197-202`: a
   ban appeal never lifts a `terminate`);
4. for each uploader, `imposeAccountHoldInTx` (`csam`), which is a no-op for a known-hash case that took it at match;
5. for each uploader **with no report already queued for this case**, queues one (`pending` or
   `awaiting_credentials`, `queued_by = 'confirm'`, `viewed_by_esp` per §3.1). Under "Option B" a known-hash case
   already has its reports, so this queues only classifier, removal-request and sighting reports;
6. keeps every media hold; writes the `csam_review` action and sets `review_outcome = 'confirmed'`,
   `priority = 'decided'`, `alarm_next_at = NULL`.

After commit: the epoch bump before **and** after the transaction for each terminated uploader (plan A's rule,
`account-actions.ts:8-11`), and the alarm stops for this case.

**When we have "actual knowledge" — the reading this design takes.**
- Under R1, a moderator's CONFIRMATION is treated as the point of "actual knowledge" for 18 U.S.C. §2258A(a)
  ("as soon as reasonably possible after obtaining actual knowledge"). Every report not already queued is queued
  **in the CONFIRM transaction**, so the duty is met within one drain tick of the decision.
- For **known-hash** matches, CireSnave chose to report **at the match** anyway ("Option B"): reporting is not
  banning, and NCMEC told him a report on a hash match is acceptable.
- ⚠️ **Legal uncertainty** (no attorney): whether a known-hash match is itself "actual knowledge" is **unsettled**.
  Reporting known-hash matches at match time is the safe side of that question.
- ⚠️ **Legal uncertainty** (no attorney): this design reads a **classifier** flag as **not** actual knowledge on
  its own, only a reason to look. That is a best safe guess, not a settled point; if it is wrong, the 24 h review
  target (§6.2) is what bounds the delay. The same reading applies to an HMS-A **removal request**: it is a reason to
  look, with a known-hash case's urgency, and a moderator's CONFIRM is what files.

### 3.6 Disposition — re-detecting a file that already has a case

`csam_case_files` has a **partial** unique index: at most one **live** (not cleared) case file per `r2_key`. A
CLEAR sets `cleared_at` on its files, which frees the key for a later case. At intake each key gets one disposition
(the pure helper `intakeDisposition`). **Precedence:** a **live** case (undecided or confirmed; at most one exists)
decides first. Only when there is no live case are the key's cleared cases consulted, and then only the
**strongest** cleared kind (`known_hash` > `classifier`) counts.

| Existing case for the key | Machine detection (`known_hash`, `classifier`) | Moderator sighting | HMS-A removal request |
|---|---|---|---|
| none | open a case | open a case (confirmed in the same transaction) | open a case |
| undecided | suppress | **attach**: record the sighting on the open case's file (`seen_by`, `seen_at`, `revealed_at`), raise its `priority` to `urgent`, and leave the decision to the CONFIRM route | **attach**: record the request against the open case, raise its `priority` to `urgent` and re-arm its alarm |
| confirmed | suppress | suppress (already confirmed); its subject is still hidden (§3.3 step 2) | suppress; the request is still recorded against the confirmed case |
| no live case; strongest cleared kind is the same or stronger | suppress | open a **new** case | open a **new** case |
| no live case; strongest cleared kind is weaker | open a **new** case | open a **new** case | open a **new** case |

For the machine column's strength, a cleared `removal_request` case counts as **weaker** than both machine kinds:
a hash match or classifier flag on a file we cleared after an HMS-A request is a new signal. A removal request for a
file we cleared always opens a new case, like a sighting: HMS-A is asking again, and a human must look again.

For example, a key with a cleared `classifier` case **and** a live (undecided) `known_hash` case is decided by the
live case: a further machine match is suppressed, and a sighting attaches to the `known_hash` case.

So a file a moderator cleared does not re-alarm when Cloudflare's next daily email, or the next scan, names it
again; the intake answers `already_cased` naming the cleared case. A file cleared as a **classifier** flag that
later turns up on a **known-hash list** opens a new case, because the new signal is stronger. A moderator's own
sighting of a cleared file always opens a new case: it is a human overriding an earlier clear.

### 3.7 Re-upload of a quarantined file

**The gap revision 2 found (at `9a76b6f`, `apps/api/src/routes/media.ts:192-200`):** `POST /media` re-`put` the
content-addressed object into the **public** `MEDIA` bucket unconditionally ("Unconditional put: the key IS the
content hash"). **Any** user who uploaded the same bytes therefore put a held object back at its public URL. That
was true before this design and of every hold (`dmca` and `other` too); it is not an artifact of R1, and
barring the original uploader would never have closed it.

**Closed on main by #147 (`f3533af`):** the upload route checks `isKeyLegallyHeld` (`legal-hold.ts:36`) for the
output key **before** the `put` (`media.ts:209`), and its `INSERT` re-checks the hold in the same statement
(`media.ts:254`). A held key is refused with the route's one existing `415 UNSUPPORTED_MEDIA_TYPE` body, with no
`media` row and no R2 write (a hold that commits between the check and the put is caught by the `INSERT`, and the
fresh public copy is moved back to restricted). The body is identical to every other refusal, but a 415 on an image that is otherwise
known-good does reveal that its bytes are held. That is accepted: the only person who learns it is one who already
holds those bytes. **This work adds:** when the hold is a `csam` one, the attempt is appended to
`csam_upload_attempts` (case, user, time) and raises the case's alarm.

**A second account (PM ruling, 2026-10-06; CireSnave may veto on board 133).** Under "Option B" and R3 ("every
uploader of a matched image is reported"):
- **A different account** uploading content that is **already reported** gets **its own** CyberTipline report,
  queued at that moment (Option B at match). "Already reported" means the case has a report: a `known_hash` case
  (reported at match while `CSAM_REPORT_AT_MATCH` is true) or any **confirmed** case. In one short transaction
  with the refusal: lock the case, append the `csam_upload_attempts` row, and, when this account has no
  `ncmec_reports` row on the case yet, insert one (`queued_by = 'reupload'`, `pending` or `awaiting_credentials`)
  with one `ncmec_report_files` row for the case file of that key (`viewed_by_esp` per §3.1), and impose a `csam`
  account hold on the account (§3.3 step 7a, with the case's `hold_action_id`). The report's `incidentDateTime` is
  the attempt time, and it names no web page, because nothing was published. The refusal is the route's plain 415
  until the PM rules on the upload-scan design's D14, which recommends the neutral 422 `IMAGE_NOT_ACCEPTED` for
  **every** held-key refusal, whatever the hold's category (amended 2026-10-07, `2026-10-07-upload-scan-design.md` §5.1). Either
  way it never fails because of this step (an error is logged and alarms).
- **The same account** repeating an upload (any account that already has a report on the case, the original
  uploader included) is recorded in `csam_upload_attempts` and re-arms the alarm, with **no** new report.
- A refused upload of a key whose case is **not** yet reported (an undecided `classifier` or `removal_request`
  case) is recorded and alarms only; the report, if any, comes at CONFIRM.
- **No bar either way** (R1): the reviewer sees every attempt on the case.

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
- **What `withdrawn` means.** NCMEC's `/retract` works only before `/finish`, and it withdraws the report: it takes
  back our **assertion**. It does **not** shorten preservation. Our evidence copy, the report as sent and the
  context around it are still kept for the full preservation period, counted from the **submission** time, because
  §2258A(h)(1) runs "1 year after the submission to the CyberTipline" (§5 P5). A report that becomes `withdrawn`
  without ever being submitted was never sent, so no statutory period applies to it (§5 P6).

### 4.2 One drain step, per report

Inside a single cron invocation:
1. `pending`: build the report XML, store **the exact bytes** (`ncmec_submissions`, preserved, §5), `POST /submit`,
   and record `ncmec_report_id` → `submitted`.
2. For each of **this report's** files (`ncmec_report_files`): read the object from `MEDIA_RESTRICTED` into an
   `ArrayBuffer` and `POST /upload` it as a `Blob` in multipart `FormData` with the report id, recording
   `ncmec_file_id`. (A `ReadableStream` cannot be a `FormData` part; the objects are re-encoded WebP bounded by
   the upload route's caps, so buffering one at a time is safe.) Then `POST /fileinfo` with `fileViewedByEsp` (the
   file's `viewed_by_esp`), `originalFileHash` (sha256) and `publiclyAvailable` (true: it was served publicly before
   the hold).
3. `POST /finish` → `finished`, with `finished_at`. A `5102` ("report already finished") answer to `/finish` means
   an earlier attempt finished it but its response was lost: treat it as success, `finished`, with
   `last_response_code = 5102` kept for the record.
4. `retract_pending`: `POST /retract` → `withdrawn` (§7.2). A `5102` (already finished) → `finished`, flagged on
   the case for the runbook. Either way, nothing preserved for this report is released (§5).

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
- `NCMEC_REPORTER_NAME`, `NCMEC_REPORTER_EMAIL`, `NCMEC_REPORTER_PHONE` (the `reportingPerson`, §4.5; required);
- `NCMEC_REPORTER_STREET`, `NCMEC_REPORTER_CITY`, `NCMEC_REPORTER_STATE`, `NCMEC_REPORTER_ZIP`,
  `NCMEC_REPORTER_COUNTRY` (the reporter's structured `<address>`; **optional as a group**: if any one of the five
  is unset or blank, the `<address>` element is **omitted entirely**, never sent half-filled, and the report still
  files);

and the var `NCMEC_BASE_URL` (exttest vs prod; there's no default, so a missing value is "not configured"). If
**any** of the six required values (the Basic-auth pair, the base URL, the reporter's name, email and phone) is
missing or blank, intake and CONFIRM write `awaiting_credentials`, and the drain re-checks
every tick and promotes those rows to `pending` once all exist. That state **alarms** (§6). There is no placeholder
value in code; the merge condition is the deploy check (AC-C13).

### 4.5 Report contents

Built from what we hold. Every field below is checked against the live XSD (`GET /xsd`) once credentials exist,
and that check is a plan task.
- `incidentType` (child pornography / CSAM) and `incidentDateTime` (the upload time of that uploader's earliest
  matched media row).
- The reporting person: name, email and phone from their `NCMEC_REPORTER_*` secrets, and the structured address
  from the five address secrets when all five are set (§4.4).
- The reported person (this report's uploader): `espIdentifier` (user id), `screenName` (handle), `profileUrl`,
  and email. **No IP data:** `clientIp()` (`apps/api/src/http/client-ip.ts:23`) exists, but only to key rate
  limiters (`search.ts:71`, `login.ts:236`, `signup.ts:158` and others); no migration stores an IP.
- The web page: the URL of every post, and of every comment's post, that embeds one of this report's files.
- Files: this report's `ncmec_report_files` only, each with `fileViewedByEsp` per §3.1: **`false` for a match-time
  report**; `true` only after a logged two-person fetch of that file, or an attested sighting.

**What a false positive means for the user.** A family photo that happens to match a hash is reported to NCMEC at
match ("Option B"), with `fileViewedByEsp = false`, which tells NCMEC no human here has looked. The user is
**reported, not punished**: the account is untouched (they can log in, post and comment), only the matched content
is quarantined, and they get no notice. If two moderators then clear it, the content comes back and the account
hold is released (§7.2, ruling d), while our evidence of the report stays preserved (§5).

## 5. Preservation (§2258A(h)) — from the match, and never less than 1 year after submission

⚠️ **Legal uncertainty: no attorney.** Every rule below is this design's reading of §2258A(h) (quoted in §0). It is
a best safe guess under CireSnave's *"proceed with best safe guesses"*. Where the statute is unclear, each rule
takes the reading that keeps evidence **longer**.

### 5.1 The preservation clock

- **P1. The period runs from submission, not from the match or the review.** Under §2258A(h)(1), a completed
  submission is "a request to preserve the contents provided in the report for 1 year after the submission to the
  CyberTipline". For each case, the SQL function `csam_case_preserve_until(case_id)` (migration `0026`) returns:
  - **NULL, which means keep everything,** while the case is undecided, or while any of its reports is in a state
    from which it could still be sent (`awaiting_credentials`, `pending`, `submitted`, `retract_pending`, `failed`);
  - otherwise **1 year after the latest of**: the match (the case's `created_at`), every `ncmec_submissions.sent_at`
    of its reports, and every report's `finished_at`.
- **Every send counts** (PM ruling, 2026-10-06: each send is its own submission). That includes a send whose answer we lost, one NCMEC later deleted unfinished (§4.3), and
  one we later retracted. "A completed submission" might mean only a finished report. This design does not rely on
  that narrower reading, because a send whose answer we lost may have completed at NCMEC.
- A deletion-window resubmission (§4.3) or a late CONFIRM-time report therefore moves the end **later**, never
  earlier.

### 5.2 What is preserved

| What | Where | Kept at least until |
|---|---|---|
| The images | the serving key in `MEDIA_RESTRICTED` under the case's `csam` media hold, from the match; after a CLEAR, the evidence copy `evidence/csam/<caseId>/<sha256>.<ext>` under its own `csam` media hold (§7.2); `<ext>` is `webp` for a serving key's copy, and the original's own extension (`jpg`, `png`, `gif` or `webp`) for an upload-time file, which is its own evidence copy from the match (amended 2026-10-07, `2026-10-07-upload-scan-design.md` §5.3) | `csam_case_preserve_until`. Then a **cleared** case's copy is destroyed unless a legal hold applies; a confirmed case's is kept (P7) |
| The report as sent | `ncmec_submissions.request_xml`, one row per send; UPDATE refused by trigger | `csam_case_preserve_until`, which includes the row's own `sent_at` + 1 year |
| The content (title, source; posts and comments) | `moderation_snapshots` (#126) with the new `csam_case_id` set, written in intake step 6 | the later of `0021`'s 1-year floor and `csam_case_preserve_until` |
| The account | a `csam` account hold, from the match (known-hash) or from CONFIRM (classifier, removal request), so neither reaper deletes or anonymises it. At a CLEAR, an account snapshot (`csam_account_snapshots`) is written before the hold is released (ruling d) | the hold: until a CLEAR releases it (§7.2). The snapshot: `csam_case_preserve_until` |
| The uploader's `media` rows | kept while the key is held: the orphan reaper skips held keys (`reap-orphan-media.ts:112`, #147). After a CLEAR, their identifying fields are in the account snapshot | the hold, then the snapshot as above |
| The case, its files, reports and removal requests | `csam_cases`, `csam_case_files`, `ncmec_reports`, `csam_removal_requests` | `csam_case_preserve_until` |
| Who did what | `moderation_actions` (incl. `csam_hold`, `csam_review`, `csam_clear_release`) + `csam_cases` | append-only |

§2258A(h)(2) also asks us to preserve "any visual depictions, data, or other digital files that are reasonably
accessible and may provide context or additional information about the reported material or person". This design
reads that as reaching the snapshots, the account record and the uploader's `media` rows (the ⚠️ reading of §3.3
step 7a).

### 5.3 The rules

- **P2. A CLEAR never shortens preservation.** A CLEAR may:
  - lift the user-facing quarantine of **non-evidence** copies: it restores the content and releases the case's
    hold on the **serving** key, so the public copy can come back;
  - release the account hold the match imposed (ruling d), after the account snapshot is written.

  The **evidence copy stays restricted** (two-person grant only) until at least `csam_case_preserve_until`. The
  serving key's hold is released only in the transaction that holds the evidence copy, after the copy is verified
  (§7.2 step 1).
- **P3. No deletion rule releases evidence earlier.** No app code deletes or releases an item in §5.2's table
  before its end. Checked at `f3533af`: no file under `apps/api/src` deletes from `moderation_snapshots`,
  `media_legal_holds` or `MEDIA_RESTRICTED`, except a move's delete-from-source (`moves.ts:104`). The same search
  finds such deletes in the tests (`media.test.ts:420`, `:425`), so it can see them. Migration `0026` adds
  database guards, so a mistake fails loudly:
  - a DELETE or TRUNCATE of a case-linked row is refused while `csam_case_preserve_until` is NULL or in the future.
    That covers `csam_case_files`, `ncmec_submissions`, `csam_account_snapshots`, `csam_removal_requests`, and a
    `moderation_snapshots` row with `csam_case_id` set;
  - a DELETE of a `csam` row in `media_legal_holds` is refused for an **evidence** key (`evidence/csam/…`) under the
    same test. For a **serving** key it is refused unless the case file for that key has an `evidence_key` that is
    itself held;
  - the hold release in a CLEAR (§7.2 step 2) touches only the serving key's hold, never an evidence key's;
  - the only reaper is P7's, for cleared cases past their end; any later release tool must also test
    `csam_case_preserve_until`.
- **P4. The one exception is the statute's own.** §2258B(c)(2) requires that a visual depiction be "permanently
  destroyed, upon a request from a law enforcement agency to destroy the visual depiction". That is a manual,
  two-person runbook step (§8): it bypasses the guard for the named items only and records who, when, and which
  request. ⚠️ Legal uncertainty.
- **P5. Retraction.** `/retract` works only before `/finish`, and it withdraws the report (§4.1). It does not change
  what we keep. The evidence copy and everything in §5.2 are still kept until 1 year after the **submission**
  time, because §2258A(h)(1) runs from submission.
- **P6. A report cancelled before it was ever submitted** (it was `awaiting_credentials`, `pending` or `failed` when
  the CLEAR came) carries no statutory preservation, because nothing was submitted. We still keep its evidence for
  at least **1 year from the match**, for the evidence purpose the existing design already serves: `0021`'s
  snapshot floor, and the evidence copy. P1 gives exactly match + 1 year when no send exists.
- **P7. After the end (PM ruling, 2026-10-06; CireSnave may veto on board 133).**
  - **A confirmed case's evidence is kept.** §2258A(h)(5) permits keeping it longer "for the purpose of reducing
    the proliferation of online child sexual exploitation or preventing the online sexual exploitation of
    children".
  - **A cleared case's evidence is destroyed** once `csam_case_preserve_until` has passed, **unless a legal hold
    applies**. It is a false positive (the newborn photo), so keeping it longer serves no purpose and costs the
    user privacy.
  - **A legal hold applies** when (i) the case carries an **evidence legal hold**: two admins set it, with a
    reason, when legal process asks us to keep the material (for example a preservation request under 18 U.S.C.
    §2703(f) or a law-enforcement request), and only two admins lift it; or (ii) another **live or confirmed** case
    holds a file with the same sha256.
  - **When:** the existing daily cron tick (`20 4 * * *`, `index.ts:74-75`) runs `destroyExpiredClearedEvidence`.
    A case becomes eligible at most a day after its end.
  - **How, per eligible case:**
    1. a short transaction locks the case, re-checks eligibility, and sets `destruction_started_at`. From then on
       an evidence legal hold can no longer be set on it;
    2. each evidence object (`evidence/csam/<caseId>/<sha256>.<ext>`, with §5.2's `<ext>`) is deleted from
       `MEDIA_RESTRICTED`, and a `head` confirms it is gone;
    3. a second transaction deletes the evidence keys' `media_legal_holds` rows, the case's `moderation_snapshots`
       (`csam_case_id`), `csam_account_snapshots` and `ncmec_submissions` rows (the report XML, which carries the
       user's details), sets `evidence_destroyed_at`, and writes a **`csam_evidence_destroyed`** audit row in
       `moderation_actions` (actor `system:evidence-reaper`; the internal note lists the evidence keys and the row
       counts). P3's guards allow each delete because the end has passed.
  - **What stays, as the audit record:** the `csam_cases` row, its `csam_case_files` (the sha256 only, which §3.6
    needs so the file does not re-alarm), the `ncmec_reports` rows (ids and final status, no content), the removal
    requests, the archived holds and every `moderation_actions` row. Match Data goes with the evidence (§11.3).
  - A run that dies between steps resumes on the next tick from `destruction_started_at`: the R2 delete is
    idempotent, and step 3 runs once.
- **P8. Secure location, limited access, and the NIST Cybersecurity Framework** (§2258A(h)(3), (h)(6),
  §2258B(c)(1); PM ruling, 2026-10-06). Plan Task 13 makes and documents these controls:
  - **Where:** evidence images live only in the restricted R2 bucket `MEDIA_RESTRICTED` (`tj-media-restricted`),
    which has no custom domain and no public `r2.dev` URL and is read only through the api Worker's binding. The
    other evidence lives in Postgres;
  - **Encryption at rest:** Cloudflare's R2 documentation says "All objects stored in R2, including their metadata,
    are encrypted at rest", automatically and with no configuration, using AES-256 in GCM mode, with keys managed by
    Cloudflare; traffic to R2 uses TLS (<https://developers.cloudflare.com/r2/reference/data-security/>, read
    2026-10-06). Postgres (Neon) at-rest encryption is **UNVERIFIED** here, and Task 13 checks it in Neon's docs;
  - **Access logging:** every fetch of held media writes a `media_access` row in `moderation_actions` naming the
    grant (§3.1), and every CLEAR, release and destruction writes its own row. Cloudflare's account audit log
    records bucket configuration changes;
  - **Two-admin access:** held media is fetchable only through #61's two-person grant, and a known-hash or
    removal-request CLEAR takes two admins;
  - ⚠️ Legal uncertainty: whether these controls are "consistent with the most recent version of the Cybersecurity
    Framework" is this design's reading, with no attorney.

### 5.4 Gaps

**Closed on main by #147 (`f3533af`):** at `9a76b6f`, `reapOrphanMedia` deleted the `media` rows of an orphan
upload with no legal-hold check, so a matched orphan's uploader row could vanish 24 h after upload. The orphan
selection now has `AND NOT EXISTS (SELECT 1 FROM media_legal_holds h WHERE h.r2_key = m.r2_key)`
(`reap-orphan-media.ts:112`).

⚠️ **What the hold cannot save: a match that arrives late.** Cloudflare's email is daily, and the orphan reaper
deletes an **unheld** orphan's `media` row and public object 24 h after upload (`reap-orphan-media.ts:105-116`,
`:144`). A match can therefore name a file whose row and bytes are already gone, before any hold existed. Intake
cannot recover it; it records the digest in `csam_unmatched_digests` and alarms (§6 condition 7), so a human sees
the loss instead of a silent `nothing_to_do`.

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
6. **new: an undecided case** (`review_outcome IS NULL`) older than **N hours**, where N = 0 for a `known_hash`,
   `classifier` or `removal_request` case (it alarms from intake) and the case is **OVERDUE** once older than
   `CSAM_REVIEW_TARGET_HOURS`. A refused re-upload of a case's file (§3.7) re-arms it at once;
7. **new: a recognised digest with no `media` row** (`csam_unmatched_digests`, not yet acknowledged by an admin):
   the evidence may already have been reaped (§5);
8. **new: held but still public:** for a key with a `csam` media hold, its **newest** `media_moves` row (0016 keeps
   history; "only the newest row per key describes its current intended bucket", `0016_media_visibility.sql:44-46`)
   is `to_restricted` and either `failed` or `pending` for longer than one drain tick. The daily retry cron
   (`20 4 * * *`, `index.ts:74-75`) is too slow, and it never retries a `failed` row, so the `*/2` CSAM tick does
   it itself: it **resets** each such `failed` row to `pending` with `attempts = 0` (logging
   `csam: reset failed move <id> for held key`), then re-attempts every such `pending` row. The condition clears
   when the newest row is `done`.

### 6.2 Review target and escalation — DECIDED (board item 125)

CireSnave, verbatim (relayed by the PM, 2026-10-05): *"I agree with the draft defaults. I agree with proposals b,
c, d, and e."* The values stay named constants in `config.ts`, each under that quote, so a later change is one
reviewed line:

| Constant | Value | Meaning |
|---|---|---|
| `CSAM_REVIEW_TARGET_HOURS` | `24` | A decision is expected within 24 h of the match. **Decided** (the draft defaults). |
| `CSAM_ALARM_REPEAT_HOURS` | `4` | A `known_hash` or `removal_request` case's URGENT email repeats every 4 h while undecided. **Decided** (the draft defaults). |
| `CSAM_CLASSIFIER_ALARM_REPEAT_HOURS` | `24` | A `classifier` case (lower confidence) repeats daily instead. **Decided** (ruling e). |
| `CSAM_OVERDUE_SUBJECT_PREFIX` | `"OVERDUE"` | Prefixed to the subject once a case passes the target. |

- **At intake:** an URGENT email to `CSAM_ALARM_EMAIL` (subject `"URGENT: CSAM match needs review"`; a removal
  request: `"URGENT: CSAM removal request needs review"`; a classifier case: `"CSAM review needed"`), with the case
  link and nothing else: no image, no hash, no handle, and no Match Data (§11.2).
- **While undecided:** the same email every `CSAM_ALARM_REPEAT_HOURS`, driven by `csam_cases.alarm_next_at` on the
  `*/2` tick, so a lost send is retried within 2 minutes. After `CSAM_REVIEW_TARGET_HOURS` the subject starts with
  `"OVERDUE"`.
- **Every tick:** the admin banner and an `ncmec ALARM` log line, for as long as any case is undecided.
- **Nothing auto-bans or auto-clears on timeout** (decided, the draft defaults). An overdue case stays quarantined
  and keeps alarming until a human decides.

### 6.3 Surfaces

- **Admin banner:** every `/admin/*` page shows a red banner with the counts and a link, from
  `GET /admin/csam/alarm`.
- **Email:** to `CSAM_ALARM_EMAIL`, a Worker secret **supplied by the operator as a secret**. Conditions 1–5: the
  daily `0 14 * * *` tick emails while the condition holds, with no dedup suppression, and conditions 2 and 5 also
  email on the tick that first raises them. Condition 6: §6.2's cadence. Conditions 7 and 8 email on the tick
  that first raises them, then daily. **First raised** is per item: condition 7 for a `csam_unmatched_digests` row,
  condition 8 for a `media_moves` row id. An item is first raised on the tick that finds it with no
  `csam_alarm_marks (condition, ref)` row; that tick emails and writes the mark, and later ticks leave it to the
  daily email.
- **Log:** an `ncmec ALARM` line every drain tick while anything holds.

## 7. Review

`/admin/csam` lists cases, **undecided first** (`urgent`, then `high`, oldest first), then the rest newest first,
with kind, source, age against the target, NCMEC status and report id, and any re-upload attempts. Previews are
**blurred**, and **Reveal** is an explicit control. Revealing sets `revealed_at` and opens a two-person
`media_access_requests` row for that case file (§3.1); a second admin approves it, and the image itself is fetched
only through that grant (§3.3 step 5). **A successful serve** under that grant is what counts as viewing (§3.1). It
does not change an already-sent report.

### 7.1 CONFIRM

§3.5. Any Access admin can confirm, once every file is viewed (§3.1).

### 7.2 CLEAR (false positive)

**Who clears (ruling b, decided).** A `known_hash` case takes **two people**: one admin records "clear" with a
statement, and a **different** admin (`sameAdminHand`, as the media grant uses) approves it, because a clear puts
a file that matched a CSAM hash list back on the public internet. A `removal_request` case also takes two people,
because it puts back a file HMS-A asked us to remove (**PM ruling, 2026-10-06**). A `classifier`
case clears with one admin.

The clear:
1. **Evidence copy first (before the transaction):** copy each file's object inside `MEDIA_RESTRICTED` to
   `evidence/csam/<caseId>/<sha256>.webp`, verify it with a `head`, and record it in `csam_case_files.evidence_key`.
   The serving copy is about to go public again. The evidence copy is what §5 preserves, until
   `csam_case_preserve_until`, which is never earlier than 1 year after the last submission (P1, P2). Any failure
   aborts the clear and changes nothing.
2. In one transaction: lock the case; set `review_outcome = 'false_positive'` with the statement and both hands;
   set `cleared_at` on the case's files (freeing the key, §3.6); write `csam_review`. **Hold each evidence key**
   (`imposeLegalHold`, category `csam`, the case's `hold_action_id`) **before** any serving hold is released (P2).
   Then **release the case's own serving-key media holds**: for each serving key, only a `media_legal_holds` row
   whose `moderation_action_id` equals the case's `hold_action_id` is moved into a new `media_legal_hold_releases`
   archive table (with the case, both hands, and `imposed_at` taken from the hold's `created_at`,
   `0016_media_visibility.sql:25`) and deleted, logged as `csam_clear_release`. A hold that predates the case
   (`dmca`, `other`, or an earlier case) is **not** this case's and stays; that key stays restricted. Deleting
   rather than adding a `released_at` column keeps every existing reader (`isKeyLegallyHeld`, `legallyHeldKeys`,
   the `ON CONFLICT (r2_key)` insert) correct without a change, and lets a later case re-impose a hold. **A CLEAR
   never releases an evidence key's hold**, and the database refuses it (§5 P3).
3. **Release the account hold (ruling d, decided).** A case **involves** an uploader when the uploader owns a
   `media` row for one of its keys or is the subject of one of its `ncmec_reports`. For each uploader of this case:
   1. write a `csam_account_snapshots` row first: the user id, handle, email and account `created_at`, and the
      uploader's `media` rows for the case's keys (`r2_key`, `created_at`). This is the (h)(2) context that the hold
      protected until now, and §5 keeps it until `csam_case_preserve_until`;
   2. then release the uploader's active `csam` account hold, but **only** when that hold's
      `moderation_action_id` is the `hold_action_id` of a **cleared** case that involves this uploader (this one
      included), **and** no other case that involves the uploader is undecided or confirmed. The release sets
      `released_at`, `released_by` (the approving hand) and a `release_reason` naming the case, and is logged as
      `account_hold_release` (an existing kind, `0022_account_legal_holds.sql:70`).

   Every other `csam` account hold stays: one a legal-hold content decision imposed, one `0022`'s backfill gave a
   terminated account (`moderation_action_id` NULL), and one a still-live case relies on. Today
   `0022_account_legal_holds.sql:27` forbids releasing **any** `csam` hold
   (`account_legal_holds_csam_never_released`), so migration `0026` replaces that CHECK with a trigger that allows
   exactly this release. The admin release route still refuses a `csam` hold (`account-holds.ts:162`). A classifier
   or removal-request case takes its account hold only at CONFIRM (§3.3 step 7a), and a confirmed case is never
   cleared, so for those kinds this step normally finds no hold the case imposed.
4. **Restore the content:** `applyDecisionInTx(c, { decision: "restore", … })` for each post or comment in
   `csam_case_targets`, which holds only content that was **visible** when the case hid it (§3.3 step 6). Content
   hidden before the match stays hidden. A `null` result (deleted since) is skipped. ⚠️ **Cross-case:** a target
   that still embeds a key with a csam hold belonging to **another** case that is live or confirmed (a
   `csam_case_files` row of another case with `cleared_at IS NULL`) is **not** restored: it is still part of that
   other case's quarantine, and un-hiding it would pre-empt that case's review. The target row records why
   (`restore_skipped_case_id`), and the list shows it; it is restored, if ever, by that other case's CLEAR.
5. **Reports (ruling c, decided):** a report that has **not** been submitted (`awaiting_credentials`, `pending`,
   `failed`) becomes `withdrawn` and is never sent. A `submitted`, unfinished one becomes `retract_pending`, and the
   drain calls `/retract` (allowed before finish). A `finished` report is left as it is, and its record is kept.
   **None of these shortens preservation** (§5): a retracted or finished report's evidence is kept until 1 year
   after its submission or finish (P5), and one cancelled before any submission is kept 1 year from the match (P6).
6. COMMIT. After commit: `afterContentDecision` with `decision: "restore"` and **no** `legalHold` for each restored
   item, which moves each of its keys that is no longer held back to the public bucket (`visibility-hook.ts:64-65`);
   and `enqueueAndAttemptMove(…, "to_public")` for a released key that no restored item embeds but some visible
   content does. A released key nothing visible embeds stays in `MEDIA_RESTRICTED`, unheld. The account was never
   barred, so nothing else changes for the user. The alarm stops.

**Audit:** the case row, both hands, the statement, the `csam_review`, `csam_clear_release` and
`account_hold_release` actions, the archived hold, the account snapshot, every `ncmec_submissions` row and the
report rows (with their final status) all stay.

**Suppression:** §3.6. The cleared file does not re-alarm on the same or a weaker signal.

**Follow-up to NCMEC after a finished report (ruling c, decided; its legal effect is uncertain).** NCMEC's ISP Web
Services has **no** amend, supplement or withdraw call for a finished report: `/retract` works only before
`/finish`, and after it "the report cannot be cancelled" (§0, read 2026-10-04). The only cross-report link,
`<priorCTReports>`, sits inside a new report about a person, and filing a new CSAM report to say "this was not
CSAM" would be wrong.
- **Our reading:** the honest path is an out-of-band message to NCMEC's CyberTipline, through the contact channel
  NCMEC gives the ESP at enrolment, naming the report id and stating that our human review found no violation. The
  runbook (§8) carries the step; the case records when it was sent and by whom. The message changes nothing we
  preserve (§5).
- ⚠️ **Legal uncertainty:** whether any follow-up is required, and whether withdrawing a not-yet-submitted
  known-hash report after a human CLEAR is right, are **unsettled**. The reading here is that once a human has
  determined there is no violation, sending a still-unsent report would knowingly report what we believe false,
  which §2258B(b)'s "intentional misconduct" exception makes the riskier side. This is a best safe guess, not
  advice, and it is CireSnave's to overrule.

### 7.3 What a CLEAR does not undo

- **Preservation.** The evidence copy and its hold, the report as sent, the snapshots, the account snapshot and
  the case records all stay until at least `csam_case_preserve_until` (§5).
- A `finished` NCMEC report stays filed (above).
- A `csam` account hold that step 3 may not release (another live or confirmed case, a legal-hold content decision,
  the `0022` backfill) stays. The user notices it only if they ask to delete their account, which then waits.
- Cloudflare's own edge block, if any, is lifted by hand in the dashboard (runbook).

Who can review: any Access admin. Access to the **images** keeps #61's two-person rule.

## 8. Out of scope (stated, not forgotten)

- **Email Worker intake (v2)**: after capturing one real Cloudflare notification.
- **Our own scanning** (R2's ruling): designed in a separate document, `2026-10-07-upload-scan-design.md`. The backfill of stored
  media enters through §3.1 (b). Upload-time scanning enters through `runUploadIntake`, a variant of §3.3's intake for
  files that were never published (amended 2026-10-07).
- **A tool for destruction on law-enforcement request**: a runbook entry in `docs/runbooks/csam.md`, which this
  work creates, covering who, how, the two-person rule, and bypassing §5 P3's guard for the named items only.
- **A tool to release a confirmed case's evidence**: none. Only a cleared case's evidence is destroyed, by §5 P7's
  daily reaper.
- **The scanner itself**, including fail-closed publishing (§11.1): the upload-scan plan builds it.
- **Editing `docs/legal`** for the HMS-A disclosure (§11.7): the upload-scan plan does that. This spec records only
  where the sentence goes.
- **Telling any user anything** (A3, and R1's quarantine): no notice at match, at confirm or at clear.
- **Lifting Cloudflare's own block**: a dashboard-only step (Security Center → Blocked Content), in the runbook.

## 9. Acceptance conditions (merge conditions for the implementation PRs)

| # | Condition |
|---|---|
| AC-C1 | After a match intake, the content is not publicly reachable: the public routes 404, and the media is out of the public bucket. Tested through the real public endpoints. |
| AC-C2 | For a **known-hash** match, no human action stands between intake and `submit`: the drain alone takes the match-time report to `finished` against the NCMEC test double. |
| AC-C3 | A report whose NCMEC deletion window has passed (or a `5001`) is resubmitted, with the old id kept in `abandoned_report_ids`. Shown to fail with the resubmit removed. |
| AC-C4 | Each of §6's eight alarm conditions produces the banner and the log line. Conditions 2, 5, 7 and 8 also send the immediate email on first raise. Each is shown to fail when its condition is removed. |
| AC-C5 | The response byte cap fires before the parser, and a test of an oversized body fails without the cap. |
| AC-C6 | `CSAM_BAR_UNREVIEWED_MATCH = false` and `CSAM_REPORT_AT_MATCH = true`, **both** equal to CireSnave's quoted words (R1, and "Option B."), quoted in the code and the PR. Both branches of each constant are tested. |
| AC-C7 | No email is sent to the uploader or author by any CSAM path (A3). |
| AC-C8 | An end-to-end run against **exttest** (`exttest.cybertip.org`) reaches `finished`, once credentials exist. **Nothing is filed to production, and APP.live does not flip, until this is shown.** |
| AC-C9 | After a match intake, every **matched** image has left the public bucket, **including an orphan upload with no embedding post**, and an innocent image co-embedded in a hidden post is **not** held (it moves only if nothing visible still uses it). Shown to fail when intake's explicit per-key `to_restricted` move is dropped (§3.3). |
| AC-C10 | A second intake of a suppressed key (§3.6) files nothing new (no new case, report, hold or alarm). Shown to fail without the disposition check. A classifier-cleared key matched by a known hash **does** open a case; a sighting of a key with an open case attaches to it (no new row, priority `urgent`, no 500); a sighting of a cleared key opens a new case. |
| AC-C11 | In a multi-uploader case, each NCMEC report carries only the files that uploader's own media rows hold (R3). |
| AC-C12 | The `fast-xml-parser` characterisation test (§4.3) passes against the exact version pinned in `apps/api/package.json`. |
| AC-C13 | Deployment: the six required NCMEC secrets/vars, the five optional address secrets and `CSAM_ALARM_EMAIL` are set as Worker secrets by the operator before the first deploy that drains. No real contact value appears anywhere in the repo, its history or the PR text. |
| AC-C14 | **Quarantine:** an unreviewed match (`known_hash` or `classifier`) or removal request **never bars the account**: after intake the uploader's `disabled_at`, `disabled_reason` and `suspended_until` are unchanged and the uploader can log in and post. The matched content is unfetchable except through `GET /media/restricted/:sha256` with an approved two-person grant. A **classifier** case queues **no** report under either value of `CSAM_REPORT_AT_MATCH`. |
| AC-C15 | **Clear:** a known-hash CLEAR takes two different admins (ruling b). It restores the posts, moves the media back to the public bucket, keeps a held evidence copy and the archived hold, withdraws an unsubmitted report (no NCMEC call), retracts a submitted unfinished one, leaves a finished one and its record intact (ruling c), writes the account snapshot and then releases the account hold the match imposed (ruling d), and writes the audit rows. An uploader with another live or confirmed case keeps the hold. Re-detecting the cleared file files nothing (AC-C10). |
| AC-C16 | **Escalation:** an undecided case alarms at the match, re-emails every `CSAM_ALARM_REPEAT_HOURS`, gains the `OVERDUE` subject after `CSAM_REVIEW_TARGET_HOURS`, and is never barred or cleared by any timer. Shown with a clock passed to the tick. |
| AC-C17 | **Re-upload (§3.7):** uploading the bytes of a held file is refused before any R2 write, and a `csam` hold logs the attempt. A **different** account re-uploading the file of a known-hash or confirmed case gets its own `ncmec_reports` row (`queued_by = 'reupload'`) and a `csam` account hold; the **same** account (or the original uploader) repeating it gets an attempt row and an alarm, and no new report; an undecided classifier or removal-request case gets no report. |
| AC-C18 | **Clear scope:** a CLEAR restores only content that was visible at the match, and releases only holds whose `moderation_action_id` is the case's `hold_action_id`; a pre-existing `dmca` hold on the same key survives. |
| AC-C19 | **Viewed:** `fileViewedByEsp` is `true` only for a file **served** under a grant its case file requested, or an attested sighting; pressing Reveal alone, or a grant fetch that 404s (object missing), leaves it `false` and writes no `media_access` row. |
| AC-C20 | **Sightings and cross-case clears:** a sighting hides its own subject even when its key is attached or suppressed; a CLEAR does not restore a target that still embeds a key held by another live or confirmed case, and records that case. |
| AC-C21 | **Preservation (§5):** `csam_case_preserve_until` is NULL for an undecided case and for one with a sendable report; it is match + 1 year for a case whose only report was cancelled before any send; and it is 1 year after the latest send or finish otherwise, including a retracted report and a resubmitted one. After a CLEAR, a DELETE of the evidence key's hold, or of an evidence-linked row (`csam_case_files`, `ncmec_submissions`, `csam_account_snapshots`, `csam_removal_requests`, a case-linked `moderation_snapshots` row), is refused before that time and allowed after it (the control). A DELETE of a serving key's `csam` hold is refused when no held evidence copy exists. Each guard is shown to fail when removed. |
| AC-C22 | **removal request (§11.4):** `POST /admin/csam/removal-requests` opens an `urgent` `removal_request` case that alarms at intake and every `CSAM_ALARM_REPEAT_HOURS`, queues **no** report, takes **no** account hold, and records HMS-A's reference. On an undecided case it attaches and re-arms the alarm; on a cleared file it opens a new case. CONFIRM queues the report. Its CLEAR takes two admins. |
| AC-C23 | **Match Data (§11.2):** no alarm email or log line carries Match Data; the email test asserts that the seeded classification and hashes appear nowhere in it. |
| AC-C24 | **Destruction (§5 P7):** with the clock passed to the tick, a cleared case past `csam_case_preserve_until` loses its evidence objects, evidence holds, case snapshots, account snapshots and submission XML, keeps its case, case-file sha256s and report rows, gains `evidence_destroyed_at` and one `csam_evidence_destroyed` audit row. A cleared case one day **before** its end, a case with an evidence legal hold, a cleared case sharing a sha256 with a live or confirmed case, and a **confirmed** case past its end all keep everything. A run killed after the R2 delete completes on the next tick. Each condition is shown to fail when removed. |
| AC-C25 | **Secure storage (§5 P8, plan Task 13):** `tj-media-restricted` has no custom domain and no enabled `r2.dev` URL (shown by `wrangler` output in the PR), only the api Worker binds it, and the NIST CSF mapping in `docs/runbooks/csam.md` names each control with its evidence. |

## 10. Dependencies and order

Plan A (#132) and plan B (#144: `applyDecisionInTx`, `afterContentDecision`) are merged; so are #126 (snapshots,
`0021`), the account legal hold (#139: `imposeAccountHoldInTx`, holds gate the reapers, `0022`), #141 (reserved-email
HMAC under `RESERVED_EMAIL_KEY`, `0023`) and #145 (`0025`). The next migration is **`0026`**. This work's own
prerequisites, the first tasks of its plan: the `applyAccountActionInTx` split, the shared media-key helper and the
`fast-xml-parser` dependency. The reaper's legal-hold exclusion and the upload route's held-key refusal are already
on main (#147, `f3533af`). Plan C (DSA) is independent.

Building and shipping this needs: the NCMEC exttest and production credentials, and the reporter and alarm secrets
(operator-supplied); at least two Access admins (§0 precondition; ruling f is **still pending**). CireSnave has
ruled on §6.2's draft defaults, §7.2's two-person clear (b), the clear's report handling (c), the account hold (d)
and the classifier cadence (e). The PM ruled on revision 3's open points on 2026-10-06 (§0; CireSnave may veto on
board 133). The implementation PRs wait for the NCMEC
credentials.

**Gated on CireSnave (board item 126): original-upload hashes.** *Record the original upload's MD5, SHA-1 and SHA-256
at upload time, from now on*, because exact-hash lists can never match our re-encoded WebP files: `POST /media`
re-encodes every upload (`media.ts` step 7) and discards the original. A plan task (Task 12) adds nullable columns
to `media` and records them before the re-encode; it is written to proceed the moment he agrees, and nothing changes
until then. The self-scanning options doc on main (`2026-10-04-csam-self-scanning-options.md`, #146) is where those
hashes would be matched.

## 11. Hash-matching service A (HMS-A): the terms this pipeline keeps

**Naming (PM ruling B, 2026-10-06; CireSnave may veto on board 133).** This repo is public, and the provider's
terms forbid any public statement that names its service other than one mandated sentence. So every public
document here calls it **hash-matching service A**, "HMS-A" in prose and `HMS_A_*` in identifiers. Its real name,
endpoints and terms are held privately by the operator and the PM, outside this repo.

**Source:** the provider's terms of use and its data-protection terms, read by CireSnave and the PM on 2026-10-05
and summarised privately. ⚠️ **Legal uncertainty: no attorney.** This is an engineering reading of the terms. The
provider may change them without notice, so they are re-read at each release that touches scanning, and the
date read is recorded here: **read 2026-10-05.** A "no known match" answer is **not** clearance: the duty to keep
CSAM off the service stays ours, so Cloudflare's scanning, the classifier path and human review all stay.

### 11.1 Fail closed

The provider's terms let it suspend or end access at any time. So:
- **An image that cannot be scanned is never published.** On any scanner outage, error, throttling, suspension,
  termination or credential refusal, the upload is **refused** with a neutral "try again later" (503): nothing is
  stored, served or published, and the uploader retries. It is never marked clean on an error. **Amended
  2026-10-07** by the upload-scan design (`2026-10-07-upload-scan-design.md` §6.5), which supersedes this bullet's
  earlier "stays in processing … retried with backoff": the scan runs inline at upload, so there is no processing
  state to hold, and a held upload would mean persisting every original.
- **Repeated failures raise an alarm** through §6.3's surfaces: the admin banner, an immediate email on a credential
  refusal and on first raise, the daily email while it holds, and a log line every tick.
- The scanner itself belongs to the upload-scan plan (§8), which chose inline refusal over an "in processing"
  state. **PM ruling (2026-10-06): fail-closed upload supersedes** the self-scanning options doc's earlier "don't
  block at launch" recommendation (`2026-10-04-csam-self-scanning-options.md` §3.3 and §8 Q1, now updated).

### 11.2 Match Data is never used for AI

**Match Data** is any result HMS-A returns: the classification, the match type, any near-match details, and
anything derived from them.
- The provider's terms require that it is used only to detect, remove and report CSAM and harmful-abusive
  material on our service.
- It is **never** used to train an AI model, **never** put into an evaluation set, and **never** given as input to
  any generative-AI or LLM prompt. That includes moderation assistants and agents, and the coding and operations
  agents that work on this project. In practice:
  - no agent session queries the production `csam_*` or `ncmec_*` tables, the scanner's result rows, or
    `/admin/csam`;
  - tests and fixtures use synthetic values only;
  - Match Data never appears in a log line, an alarm email, an issue, a PR or a commit (AC-C23).
- **This also applies to the PhotoDNA scan step.**
- Only the people who need it see it: the Access admins, through `/admin/csam`.

### 11.3 Retention of Match Data

The provider's terms require that Match Data is kept no longer than its purpose needs. **The stated purpose is
legal and audit:**
- **legal:** preserving the evidence of a CyberTipline report under §2258A(h) (§5), and answering legal process
  about it. The provider's terms permit keeping Match Data to comply with law;
- **audit:** the record of why content was quarantined, reported, confirmed or cleared.

Match Data that opens or joins a case is stored only with that case (the case rows, and the scanner's per-object
row it links to). It is kept no longer than that case's evidence (§5), and it is destroyed with a cleared case's
evidence (§5 P7). A "no known match" answer is not kept beyond what the scanner needs to show that an object was
scanned (its status, time and list version). Match Data is never copied anywhere else.

### 11.4 Removal requests from HMS-A

The provider's terms let it ask us to remove content, including content it earlier answered "no known match".
- **Intake path:** the **monitored contact** is the address registered with HMS-A, which its terms require to be
  the one used primarily for the service. The operator routes it to the same inbox as `CSAM_ALARM_EMAIL`, so a
  request gets the same attention as an alarm. The address is operator-held and never appears in this repo.
- A moderator enters each request through §3.1 (d). That opens an **`urgent`, `removal_request` case** with the
  same alarm clock as a known-hash match: an URGENT email at intake, again every `CSAM_ALARM_REPEAT_HOURS`, and
  OVERDUE after `CSAM_REVIEW_TARGET_HOURS` (§6.2). The list shows the request's own `receivedAt` beside the case's
  age.
- **A request is not a CyberTipline report by itself; a moderator decides.** CONFIRM terminates the uploaders and
  files (§3.5). CLEAR takes two people (§7.2; **PM ruling, 2026-10-06**) and restores the content.

### 11.5 Credentials

`HMS_A_USERNAME`, `HMS_A_PASSWORD` and `HMS_A_BASE_URL` are held **only** as Worker secrets on
`thinkersjournal-api` (`apps/api/wrangler.jsonc:4`). `HMS_A_BASE_URL` is a secret, not a committed var, because a
var in `wrangler.jsonc` would publish the provider's host (amended 2026-10-07, `2026-10-07-upload-scan-design.md` §8, pending the PM's
D8). As the provider's terms require, the credentials are never
shared with any third party: never written into code, docs, tests, commits or PR text, never logged (a request
log line names the operation and the status only), and never given to another project or Worker.

### 11.6 Hash-only is preferred; sending images is disclosed

- **Preferred:** HMS-A's hash-only PDQ endpoint sends PDQ hashes only, so **no user image leaves us**.
- **Fallback:** HMS-A's media endpoint sends the image bytes. CireSnave permitted it, verbatim: *"I'm fine with
  sending images to remote servers to be checked."* The provider's terms let it process submitted media outside
  the United States, share it with partner organisations abroad for classification, and keep what it received
  after we leave.
- So the fallback is used only when the hash path cannot serve an object, the scanner records which path scanned
  each object, and the fallback's use **must be disclosed** (§11.7).

### 11.7 The privacy-policy disclosure

The provider's mandated disclosure sentence (held privately) is added to the privacy policy at rollout, with
[[LEGAL_ENTITY]]. `[[LEGAL_ENTITY]]` stays a placeholder until board item 129 names the legal entity. The sentence
is used exactly as the provider gives it, and is not quoted in this repo before rollout.

**Where it goes** (the upload-scan plan makes the edit, not this work):
- `docs/legal/privacy-policy.md` §2, next to "scanning uploaded images for known CSAM";
- the same policy's §4 (Sharing), as a sentence of its own. It is **not** a row in §3's table, which lists
  processors acting "on our behalf"; the provider's data-protection terms make it an independent controller;
- §9 (International transfers) says that, when the fallback is used, an uploaded image may be seen by
  child-protection organisations outside the United States. That wording must **not** name the provider.

**Any other public wording about scanning must not name the provider or its service.** That covers docs,
policies, blog posts, status pages and release notes.

### 11.8 No logo, no other use of the provider's name

No logo of the provider appears anywhere on the site. Its name appears publicly only inside the mandated sentence.
HMS-A is never cited in pricing or in a paid-tier feature, as its terms require.

### 11.9 Incident runbook additions

The runbook (`docs/runbooks/csam.md`) gains an incident section:
- **A credential leak, or a breach** touching the HMS-A credentials, Match Data or images we submitted: the
  provider's terms require that we notify **the provider immediately**, through the contact it gives at
  registration (held privately). Then rotate both secrets.
- The provider's data-protection terms make us an **independent controller**. So we also notify the **affected
  people** and the **authorities** as the law requires, answer users' access and deletion requests about this
  processing, and keep our own record of it. ⚠️ Legal uncertainty: which authorities and deadlines apply (US state
  breach laws; GDPR for users in the EEA) is not settled, and there is no attorney.
