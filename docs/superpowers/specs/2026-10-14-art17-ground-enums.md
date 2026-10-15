# DSA Art. 17: structured grounds on a content decision (ACCEPTED)

**Status:** ACCEPTED as proposed by CireSnave, board 206 call 1, quoted by the PM: "On decision 206, Call 1, accept." Part of #57 (PR-C). Not attorney-reviewed.
**Ruling honoured:** CireSnave (board 197, via PM), Q5: two structured fields, `legal_ground` and
`contractual_ground`, each an enum. Q6: `violation_category` stays internal and unchanged.
**The values below are the accepted lists.** The attorney questions at the end stay open. No statute is named beyond what
the repo's legal drafts already cite (17 U.S.C. §512 in `dmca-policy.md`).

## 1. Fields

Both are columns on `moderation_actions` (migration 0031), optional, independent, NULL on every
earlier row ("not recorded" is true of them). Single source of the lists:
`LEGAL_GROUNDS` / `CONTRACTUAL_GROUNDS` in `packages/shared/src/admin.ts` (used by the CHECKs'
mirror, the route validation and the admin form selects).

### legal_ground: the content is illegal

| Value | Basis in the repo's drafts |
|---|---|
| `csam` | Guidelines section 1, item 2 (zero tolerance, NCMEC). |
| `copyright_infringement` | Guidelines item 10; `dmca-policy.md` (17 U.S.C. §512). |
| `illegal_content_other` | Guidelines item 1 ("Is illegal, or facilitates illegal activity"). |

Only grounds the product acts on today. Not added, deliberately: any per-statute or per-country
ground (needs counsel; would invite claims the product cannot back).

### contractual_ground: a Terms / Community Guidelines clause

| Value | Guidelines section 1 item |
|---|---|
| `guidelines_threats_harassment` | 3 (threatens, harasses, bullies, incites violence) |
| `guidelines_hate_speech` | 4 |
| `guidelines_ncii` | 5 (non-consensual intimate imagery) |
| `guidelines_doxxing` | 6 |
| `guidelines_spam` | 7 |
| `guidelines_malware_phishing` | 8 |
| `guidelines_impersonation` | 9 |
| `guidelines_ip` | 10 (IP; the contractual face of the copyright clause) |
| `terms_other` | a Terms of Service breach no clause above names |

Items 1 and 2 of the Guidelines are not here: they are illegality, so they live in `legal_ground`.
Values are clause-named, not number-named, so renumbering the draft does not corrupt stored rows;
the comments in `admin.ts` give the item numbers at the time of writing.

## 2. Semantics (decisions)

- **Independent and both nullable.** One decision can be both illegal and a terms violation (a
  pirated post is `copyright_infringement` and `guidelines_ip`); forcing a choice would lose that.
- **Not required.** A required field would break the existing form and every old-style API caller.
  Consequence to state plainly: a keep_hidden/remove can still be recorded with neither ground. If
  counsel wants one required, that is a one-line route change (not a data change).
- **Restore: both must be absent.** 400 INVALID_INPUT, same pattern as `violationCategory` and
  `durationHours`: a restore clears a violation, a ground on it is meaningless.
- **`violation_category` is untouched** and remains internal (Q6). The grounds are a different,
  author-facing axis; the two are not derived from each other (a `sexual` category can be CSAM, NCII
  or neither).
- **Never inferred.** Neither ground is derived from `violation_category`, a legal hold, or a notice.

## 3. What this PR does NOT do (follow-ups)

1. **Notice rendering.** The grounds WILL be shown to the author, but `notify-*.ts` is not edited
   here; the admin form labels say "shown to the author" in anticipation. Until the rendering PR
   lands the values are recorded only.
2. **Appeal page.** `AppealTarget` / `routes/appeals.ts` / `appeal.astro` do not expose the grounds
   yet. Follow-up, with the notice rendering, so the two surfaces state the same grounds.
3. **Transparency / DSA database export** of the grounds, if wanted.

## 4. Open questions for review

- Is `illegal_content_other` acceptable, or must "illegal" always name the provision? (Art. 17
  asks for the legal ground relied on; a generic bucket may not satisfy that.)
- Should NCII also be a legal ground (it is illegal in many places) as well as a Guidelines clause?
  Left contractual-only because the drafts do not assert its illegality.
- Is `terms_other` too loose a catch-all?
