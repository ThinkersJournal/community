# Community Guidelines: do the notices and decisions match the published rules?

**Status:** audit + proposal, docs only. Part of #57.
**Ref:** all file:line citations are at `origin/main` 2f58a32 (worktree `tjc-guidelines`, HEAD 2f58a32).
**Ruling honoured:** CireSnave (via PM): keep the phrase "Community Guidelines" in notices; the guidelines
must be PUBLISHED and decisions must match them.
**Not touched:** `docs/legal/community-guidelines.md` (attorney-gated draft), any `notify-*.ts` copy.
Facts are stated as facts; lines starting "Recommendation" are not facts.

"G:n" below means line n of `docs/legal/community-guidelines.md`.

## 1. AUDIT

### 1.1 The seven categories

The list is `REPORT_REASONS` = spam, harassment, hate, sexual, violence, ip_infringement, other
(`packages/shared/src/moderation.ts:9-17`). The same seven are the CHECK on
`moderation_actions.violation_category` (`apps/api/migrations/0013_moderation_actions.sql:24-25`) and the
`reports_reason_valid` CHECK (`0012_moderation.sql:34`). Confirmed: identical lists.

| Category | Governing clause(s) | Fit |
|---|---|---|
| spam | G:40-41 "7. **Is spam**" | Good. G:42-43 item 8 (malware/phishing/scams) has no bucket of its own; spam is the closest. |
| harassment | G:32 "3. **Threatens, harasses, bullies, or incites violence**"; G:38 "6. **Doxxes**" | Good for item 3. Doxxing has no category; harassment or other by moderator choice. |
| hate | G:33-35 "4. **Is hate speech**" | Good; names the protected classes. |
| sexual | G:36-37 "5. **Is non-consensual intimate imagery**"; G:18-21 "2. **Sexually exploits or endangers children**" | Covered, but one bucket holds CSAM and NCII, which need very different handling (1.3). `apps/api/src/routes/admin.ts:116-118` says "not every sexual-category report is CSAM". |
| violence | G:32 (same item 3, "incites violence") | Vague: one clause for harassment and violence; no definition of graphic or gratuitous violence. |
| ip_infringement | G:45-47 "10. **Infringes intellectual property**" + `dmca-policy.md` | Good for copyright. Trademark is routed to "contact" (`dmca-policy.md:77-82`). |
| other | no clause; nearest is G:17 "1. **Is illegal**" | See 1.2. |

### 1.2 Gaps, both directions

Category with no clause or a vague one (facts):

- **violence**: only the combined item at G:32.
- **other**: a free bucket. Nothing in the guidelines says what "other" content is actionable.
  `apps/web/src/pages/admin/queue.astro:134-140` offers every `REPORT_REASONS` value plus "(none)".
- **The category is optional on a decision.** `admin-accounts.ts:112` accepts `violationCategory` undefined;
  `queue.astro:74-77` sends it only when non-empty and the decision is not restore. A removal or ban can be
  recorded with no category and so with no mapping to any clause. The category is also "internal ... not shown
  to the author" (`queue.astro:133`); the author sees only the free-text reason (`queue.astro:128-131`).
  Nothing stored ties a decision to a clause number.

Clauses that no category can express (facts):

| Clause | Why no bucket |
|---|---|
| G:17 "1. Is illegal, or facilitates illegal activity" | Generic; `other` is the only fit. |
| G:18-21 "2. Child sexual exploitation" | Only via `sexual`; the `csam` legal-hold category is a separate explicit choice (`admin.ts:115-121`, `packages/shared/src/admin.ts:45`). |
| G:42-43 "8. Malware, phishing, scams, account compromise" | spam or other. |
| G:44 "9. Impersonates" | other. |
| G:38 "6. Doxxes" | harassment or other. |
| G:49-52 handle rules (squatting, selling, reclaiming misleading handles) | No category and no reclaim code (3.2). |
| G:59-61 "Reporting in bad faith ... is itself a violation" | No category and no code sanctions it (3.2). |

Converse: no category lacks a clause entirely; all seven have at least a loose one.

### 1.3 Illegal-content, DMCA and CSAM paths

- **DMCA / copyright**: covered in `docs/legal/dmca-policy.md` (repeat infringers at `:63-75`), and the
  guidelines point to it (G:45-47). A formal DMCA hold is a separate explicit choice at decision time, never
  inferred from `ip_infringement` (`apps/api/src/routes/admin.ts:115-121`).
- **Illegal content without an account**: G:82-89 describe `/dsa-notice`. Code matches in kind: the form exists
  and uses `REPORT_REASONS` (`apps/web/src/pages/dsa-notice.astro:114-118`), the email-confirmation window is
  7 days (`apps/api/src/moderation/dsa-notices.ts:62`), and notices never auto-hide (`dsa-notices.ts:3`).
- **CSAM**: G:18-31 state removal and NCMEC reporting, with a bracketed "NOT YET TRUE" note citing #114.
  Code: `user_terminate` exists as a primitive (`apps/api/src/moderation/account-actions.ts:24,50,63`), but I
  found no non-test caller passing `kind: "terminate"`, and `admin-accounts.ts:114-115` says the terminate path
  "has no admin button at all". NCMEC: the only hit in app source is a comment, `media/legal-hold.ts:13`.
  So G:70-72 "Severe violations ... immediate termination" describes a state no moderator action reaches today.
- **Internal inconsistency in the draft**: the bracket at G:22-31 says nothing sets
  `disabled_at`/`suspended_until`; the bracket at G:73-75 says warning/suspension/ban exist. Code
  (`account-actions.ts:56-64`) shows they exist, so G:22-31 is stale on that point.

Not-found claims and positive controls:

| Claim | Query | Control |
|---|---|---|
| No NCMEC/CyberTipline code | `git grep -n -i "ncmec\|cybertip" -- apps/api/src apps/web/src` returns one line, a comment (`legal-hold.ts:13`) | Same pattern over `docs/legal/community-guidelines.md` finds G:20 and G:25 |
| No terminate caller | `git grep -n '"terminate"' -- apps/api/src ':!*.test.ts'` returns only `account-status.ts` (reads) and `account-actions.ts:24,82` | `suspensionHours` call site found by the same style of grep at `admin-accounts.ts:153` |
| No pre-publish scoring | `git grep -n -i "toxicity\|perspective\|prescor\|pre-publish" -- apps/api/src` returns 0 lines | `git grep -n "AUTO_HIDE_REPORTER_THRESHOLD" -- apps/api/src` finds `auto-hide.ts:33` |
| No bad-faith-report sanction | `git grep -n -i "bad.faith\|retaliat" -- apps/api/src ':!*.test.ts'` returns 0 lines | same control as above |
| No handle reclaim | `git grep -n -i "reclaim" -- apps/api/src` returns only media/cron comments (`index.ts:40,55`, `reap-orphan-media.ts:2`), none about handles | the grep matches those unrelated lines, so it works |
| No muting | `git grep -n -i "mute" -- apps/api/src apps/web/src` finds nothing feature-like | G:103 is conditional ("If we offer muting"), so consistent |

Caveat on the 0-line results: the patterns are word guesses; a feature named otherwise would be missed.

### 1.4 Where else the repo tells users about guideline content

Every user-facing reference to "Community Guidelines" outside docs (`git grep -n -i "guidelines" -- apps packages ':!*.md'`):

| Where | What it asserts |
|---|---|
| `apps/api/src/moderation/notify-account.ts:41` | warning "for breaking our Community Guidelines" |
| `notify-account.ts:43` | suspension "for breaking our Community Guidelines" |
| `notify-account.ts:45` | ban "for breaking our Community Guidelines" |
| `apps/api/src/moderation/notify-author.ts:54` | keep-hidden after review "does not meet our Community Guidelines" |
| `notify-author.ts:58` | hidden after a report "does not meet our Community Guidelines" |
| `notify-author.ts:62,66` | removal "does not meet our Community Guidelines" |
| tests (`admin-decision-route.test.ts:266,275,709`; `moderation-notify.test.ts:80,83,132,145`) | fixtures only, "Violates the guidelines." |

Dead / missing links (facts):

- **None of the email lines above links to a guidelines page, and there is no such page.** `apps/web/src/pages/`
  has no `guidelines*` file at 2f58a32, and `git grep -n "/guidelines" -- apps packages` returns 0. Control:
  `git grep -n "/dsa-notice" -- apps/web/src` finds `[slug].astro:376`.
- The only legal link in the web app is the footer's "Privacy", to `https://thinkersjournal.com/privacy`
  (`apps/web/src/components/Footer.astro:26`), an external marketing-site URL this repo cannot show exists. No
  terms, DMCA or guidelines link anywhere in `apps/web/src`.
- Relative cross-links among the drafts (`terms-of-service.md:9,50`, `dmca-policy.md:74,82`,
  `community-guidelines.md:10,21,47`) resolve inside the repo only.
- `notify-account.ts:19` and `account/delete-request.astro:105-106` cite "our privacy policy" with no link:
  same publication gap, out of scope here.
- The appeal link G:76-79 promises does exist: `notify-author.ts:90` (not for restore) and
  `notify-account.ts:54-58`.

## 2. PROPOSAL (recommendations, not decided)

### 2.1 Public route

Fact: the web app serves no legal page today. There is no content collection and no Markdown page in
`apps/web` (`git ls-files apps/web | grep -E "\.mdx?$"` is empty; control: `astro.config.mjs` is listed).
Privacy is an off-site link. The repo already has a sanitising renderer, `renderMarkdown` from
`@thinkersjournal/markdown` (`apps/web/src/pages/[handle]/[slug].astro:43`; last step rehype-sanitize, `:393`).

Recommendation: add `apps/web/src/pages/guidelines.astro` serving `/guidelines`, following the `tags.astro`
public pattern (`PageLayout`, `markPublicCacheable`, `setPublicPageCsp`, `canonical`). Text source, a build
decision:

- A: copy the reviewed text into `packages/shared` (or web) as a string constant at publish time, so only a
  deploy changes what is shown.
- B: import the Markdown at build with Vite `?raw`; needs a path from `docs/legal/` the Worker build can read
  (check bundling first).
- Not recommended: fetching the text from the API per request.

Also: footer link "Community Guidelines" (siblings when their own publication is decided); a site-wide
`/dsa-notice` link (already finding F7, `docs/audits/2026-10-14-page-reachability-audit.md:204`); add
`/guidelines` to `sitemap.xml.ts`. The published page must not carry the "DRAFT, not in force" banner, so
the publish step is also the step that removes it (section 3).

### 2.2 Version stamp

Recommendation:

- One `GUIDELINES_VERSION` (date string such as `"2026-11-01"`, or `"1.0"`) and `GUIDELINES_EFFECTIVE_DATE`
  exported from `packages/shared`, the same shape as `APPEAL_WINDOW_DAYS` (`packages/shared/src/admin.ts:219`,
  imported by `notify-account.ts:15` and `notice-links.ts:16`).
- Mirror the stamp in the text's header (the draft already has `**Effective:**` at G:5) and add a test that
  fails when the constant and the text differ.
- Page: "Version X, effective D" under the heading, with an optional changelog at the foot.
- Email: "Community Guidelines (version X)" linked to `https://community.thinkersjournal.com/guidelines`.
  Optionally a clause anchor (`/guidelines#spam`), which needs stable heading ids the draft lacks today.
  Notice wording is for the `notify-*.ts` owners once redress wording is ruled; not touched here.

### 2.3 What to store if a decision is ever tied to a version (OPTION, not decided)

Fact: a decision stores `violation_category` (nullable, internal) and free-text `reason`
(`0013_moderation_actions.sql:24-30`); the log is append-only and DB-enforced.

1. `guidelines_version text NULL` on `moderation_actions`, written from the constant at decision time.
2. Also `guideline_clause text NULL` (a clause id), so category + clause + version is reconstructable.
3. Store nothing; infer from `created_at` against a dated changelog.

Any column needs a migration; old rows stay NULL. Making `violation_category` required (1.2) is a related,
separate option.

## 3. BLOCKERS

### 3.1 Publication gate

- The draft header: "DRAFT (not in force; not reviewed by an attorney)" (G:1-3), and `docs/legal/README.md`:
  "THESE ARE DRAFTS, NOT LEGAL ADVICE, AND NOT IN FORCE". **Publication needs the attorney review the brief
  names; no publication before that.** The README also records CireSnave's 2026-10-02 "no attorney ... best
  safe guesses" ruling and forbids calling the drafts attorney-reviewed. Whether that ruling lifts the gate is
  for the PM and CireSnave; both sources are listed here, not reconciled.
- Open placeholders in the guidelines: `[[EFFECTIVE_DATE]]` (G:5), `[[LEGAL_ENTITY]]` (G:5, stays), `[[3]]`
  (G:63), `[[CONTACT_EMAIL]]` (G:121), and two status brackets (G:22-31, G:73-75) that cannot ship as is.
- G:18-21 states CSAM removal and NCMEC reporting as practice while its own bracket says that is not yet true
  (#114). Un-bracketed, it would be a false statement today.

### 3.2 Clauses that conflict with, or are not backed by, code (each read in code)

| Draft says | Code says | Verdict |
|---|---|---|
| G:62-64 auto-hide at `[[3]]` distinct members in 24h | `AUTO_HIDE_REPORTER_THRESHOLD = 3` (`auto-hide.ts:33`); `interval '24 hours'` (`auto-hide.ts:61`); distinct via `UNIQUE (reporter_id, post_id)` (`0012_moderation.sql:38-39`); reports older than the latest content decision are ignored (`auto-hide.ts:62-64`) | Matches, plus an undisclosed rule: after a restore, earlier reports stop counting. |
| G:76-79 appeal within 30 days; termination not appealable | `APPEAL_WINDOW_DAYS = 30` (`packages/shared/src/admin.ts:219`); `APPEALABLE_ACTIONS` = keep_hidden, remove, warn, suspend, ban, not `user_terminate` (`admin.ts:232-239`) | Matches. Only moderator decisions are appealable (`new-post.astro:374-380`). |
| G:70-72 "temporary suspension", no length | Menu 24h / 168h / 720h, default 168h (`packages/shared/src/admin.ts:118-120`); a new suspension never shortens an existing bar (`GREATEST`, `account-actions.ts:61`) | Not a conflict. Recommendation: state the three lengths. |
| G:70-72 severe violations "skip the ladder ... immediate termination" | No moderator path to `terminate` (1.3); ban is the maximum and is reversible on appeal (`appeals.ts:197-202`) | Conflict today. |
| G:67-69 pre-publish machine scoring | No scoring code found (1.3 controls) | Not backed by code, though worded "may". |
| G:56-58 "automated signals only prioritize review, they do not decide it" | `maybeAutoHide` sets `hidden_at` with no human (`auto-hide.ts`, the two UPDATEs). The draft discloses this itself at G:62-66 | Self-inconsistent sentence. Recommendation: "except the provisional auto-hide below". |
| G:49-52 handle available "after a 30-day grace period"; misleading handles "may be reclaimed" | Handle is freed when the account is anonymised, 30 days after the deletion request (`auth/anonymise-accounts.ts:106,236,245-247`); reserved list exists (`auth/reserved-usernames.ts`); no reclaim mechanism found (1.3) | Deletion case matches; reclaim not implemented. |
| G:59-61 bad-faith reporting "is itself a violation" | No category and no sanction path (1.3) | Not backed by code. |

### 3.3 Claims I could not verify

- That `https://thinkersjournal.com/privacy` (or any marketing-site legal page) exists; it is outside this repo.
- G:82-89's last sentence (outcome and moderator reason emailed to a DSA reporter): I confirmed the reason
  field and the never-auto-hide rule, not the reporter send path.
- Whether Cloudflare's CSAM Scanning Tool is enabled on the production zone (the draft says the repo cannot
  show it).
- That `[[3]]` is the intended threshold: code says 3, but only the design decision (#14) can say it is right.
- All "not found" results are string-pattern searches (see 1.3 caveat), not proofs of absence.
