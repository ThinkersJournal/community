# DSA Art. 17 statement of reasons: what the system records and sends today (facts only)

**Status:** FACTS ONLY. No code, no wording, no legal conclusions. Written 2026-10-14 against `origin/main`
**975618a48a94fc9219a14365785ab1ac66fa4356** (975618a, "test(e2e): single-process ledger project ... (#185)").
Every `file:line` below is at that SHA (read from the worktree, which equals it); re-read before building.

**Purpose:** issue #57 gap C. Gives CireSnave and the attorney a per-element inventory so they can decide the
wording. The six elements are listed by letter with a neutral paraphrase only; what each one requires is the
attorney's question, not this note's.

**Entity:** every email in this note is sent `from: "noreply@thinkersjournal.com"` (notify-author.ts:95). Nothing
in the author-facing copy names a legal entity; the placeholder for any future wording stays `[[LEGAL_ENTITY]]`.

## 0. The one-paragraph picture

A moderator decision on content is one `moderation_actions` row (append-only, migration 0013) holding who, what,
which content, an optional category, a free-text reason and an internal note. The author email is built from
**only** the decision kind, whether the content was hidden before, the content's title, the reason text and an
appeal link (`ModerationNotice`, notify-author.ts:25-33). Everything else in the table is not sent. Automation
(auto-hide) writes no `moderation_actions` row at all. A decision is not linked to the notice that prompted it
from the action's side; the link runs the other way, from `dsa_notices.resolution_action_id` to the action.

## 1. Where each artefact lives (so the matrix can cite short names)

| Artefact | What it is | Cite |
|---|---|---|
| `moderation_actions` | one append-only row per decision/account action; UPDATE and DELETE refused by trigger | migrations/0013_moderation_actions.sql:11-33, trigger :43-51 |
| decision write | `recordModerationAction` INSERT of 10 columns | moderation/actions.ts:52-71 |
| content decision | `applyDecisionInTx`: sets `hidden_at`, appends the row, resolves confirmed notices, one transaction | moderation/decide.ts:102-201 |
| admin route | `POST /admin/decision` | routes/admin.ts:77-228 (shape check :107-147) |
| author notice | `sendModerationNotice`, `COPY` table | moderation/notify-author.ts:47-102 |
| auto-hide notice | `sendAutoHideNotice`, `notifyAutoHidden` | moderation/notify-author.ts:117-208 |
| account notice | `sendAccountActionNotice` | moderation/notify-account.ts:49-81 |
| reporter notice | `sendDsaOutcome`, `sendDsaOrphanedOutcome` | moderation/notify-reporter.ts:45-66, :83-103 |
| appeal | `appeals` table, `fileAppeal`, `/appeal` page | migrations/0024_appeals.sql:12-30; moderation/appeals.ts:70-93; web pages/appeal.astro |
| DSA notice intake | `dsa_notices` table, `createDsaNotice` | migrations/0020_dsa_notices.sql:24-61; moderation/dsa-notices.ts:32-60 |

`moderation_actions` columns, all from 0013:11-33: `id` uuid, `actor_admin` text NOT NULL, `action` text NOT NULL
(CHECK list, extended by later migrations), `post_id` uuid NULL, `comment_id` uuid NULL, `subject_user_id` uuid NULL,
`subject_label` text NULL, `violation_category` text NULL (CHECK: spam, harassment, hate, sexual, violence,
ip_infringement, other), `action_expires_at` timestamptz NULL, `reason` text NOT NULL, `internal_note` text NULL,
`created_at` timestamptz NOT NULL. No foreign keys, deliberately (0013:5-10).

## 2. Per-element matrix: content decisions (`keep_hidden`, `remove`, `restore`)

"Stored" = what the database holds. "Author email" = what the email actually contains. "Admin route" = what
`POST /admin/decision` accepts. "Appeal" = what `/appeal` shows or allows.

### (a) What the decision entails (removal / disabling / demotion / visibility restriction / suspension), territorial scope, duration

| | Fact | Cite |
|---|---|---|
| Stored: kind | `moderation_actions.action` = `content_restore` / `content_keep_hidden` / `content_remove`, NOT NULL | 0013:16-19; decide.ts:74-78 |
| Stored: effect | `posts.hidden_at` / `comments.hidden_at` timestamptz NULL, set to `COALESCE(old, now())` for keep_hidden and remove, NULL for restore. "Removed, final" vs "hidden pending review" is distinguished only by the `content_remove` row, not by a column | migrations/0012_moderation.sql:49-50; decide.ts:88-92, header :8-11 |
| Stored: territorial scope | NOT RECORDED. Every restriction is global: `hidden_at` is "a plain column ... filtered out of every public read" | auto-hide.ts:5-7 (global, not per-viewer); no column named territory/country/jurisdiction in moderation_actions (0013:11-33). Control: the same read of 0013 finds `violation_category` at :24 and `action_expires_at` at :29 |
| Stored: duration of a content decision | NOT RECORDED. `action_expires_at` exists on the table but `recordModerationAction` is called from decide.ts:148-158 without `actionExpiresAt`, so it is NULL for every content row. A content decision has no end date in code | decide.ts:148-158; actions.ts:66. Control: account-actions.ts:114 passes `actionExpiresAt` and does set it |
| Author email: what happened | Subject and lead by (decision, was-hidden) pair, quoted below | notify-author.ts:47-68 |
| Author email: territorial scope / duration | NOT STATED. No sentence in `COPY`, `contentLine` or the body names a territory or a duration | notify-author.ts:47-99. Control: the same file's line 91 contains "within ${APPEAL_WINDOW_DAYS} days", a duration, so a duration string would be visible if present |
| Admin route | `decision` in {restore, keep_hidden, remove}; no scope or duration field is read from the body | admin.ts:66, :112-125 |
| Appeal | `/appeal` shows `action` with underscores replaced by spaces ("content keep hidden") and the reason | web pages/appeal.astro:181-184 |

Author email strings by decision (notify-author.ts:47-68; `from` noreply@thinkersjournal.com, stream `outbound`, no
unsubscribe header, :94-101):

| Key (decision : was hidden before) | Subject | Lead |
|---|---|---|
| `restore:true` | "Your content has been restored" | "We reviewed your content and restored it. It is visible again." |
| `keep_hidden:true` | "Your content remains hidden after review" | "We reviewed your content and it remains hidden because it does not meet our Community Guidelines." |
| `keep_hidden:false` | "Your content has been hidden after review" | "We reviewed a report about your content and have hidden it because it does not meet our Community Guidelines." |
| `remove:true` | "Your content has been removed" | "We reviewed your content and removed it because it does not meet our Community Guidelines." |
| `remove:false` | "Your content has been removed" | same lead as `remove:true` |
| `restore:false` | no email: a restore of never-hidden content is a dismissal, `sendModerationNotice` returns before sending | notify-author.ts:79 |

Observations that are facts about the strings, not conclusions: the text of the `keep_hidden:false` lead says "a report";
the `remove:*` leads and the `keep_hidden:true` lead do not say whether a notice or own-initiative review prompted them;
the email does not distinguish "remove" as final from "hidden pending review" other than by the word chosen.

Full body (notify-author.ts:98-99): lead, blank line, `This is about your post "<title>".` or `This is about your
comment on "<post title>".` (:83-86), "Reason given by the reviewer:", the reason text, then (if an appeal link exists
and the decision is not restore) `You can appeal this decision within 30 days: <url>` (:88-92; 30 =
`APPEAL_WINDOW_DAYS`, packages/shared/src/admin.ts:219).

Identification of the content: the post title, or the parent post's title for a comment. For a comment the email
does NOT quote the comment's own text (`postTitle` is `p.title`, decide.ts:132; comment contentLine :86).

### (b) Facts and circumstances relied on; whether on a notice or own-initiative; notifier identity where strictly necessary

| | Fact | Cite |
|---|---|---|
| Stored: facts relied on | `moderation_actions.reason` text NOT NULL (moderator free text, non-blank enforced at the route) and `internal_note` text NULL | 0013:30-31; admin.ts:133 |
| Stored: `internal_note` set by the decision route? | NOT SET. `handleAdminDecision` builds the `applyDecision` input without `internalNote`; the column exists and `DecisionInput` accepts it | admin.ts:150-158; decide.ts:37. Control: account-actions.ts:38 and admin-accounts.ts:150-155 likewise omit it, and `DecisionInput.internalNote` is declared at decide.ts:37, so the omission is visible by reading the call sites |
| Stored: snapshot of the content as decided | `moderation_snapshots` (title, body_markdown, captured_at, author_id, bare post/comment id), written only when the author deletes content that is under moderation, retained at least 1 year | migrations/0021_moderation_snapshots.sql:26-35, :21-24. Not written by the decision itself |
| Stored: notice vs own-initiative | NOT RECORDED on `moderation_actions`. No `notice_id`, `report_id` or equivalent column. Control: `grep -rniE "notice_id\|report_id\|dsa_notice_id\|source_notice"` over `apps/api/migrations` and `apps/api/src` (excluding tests) returns no hits, while the same tree contains `resolution_action_id` at migrations/0020_dsa_notices.sql:39 and decide.ts:165, so the search reaches the files that matter |
| The link that does exist | Notice -> action only: at decision time, every confirmed, unresolved `dsa_notices` row on the same post/comment gets `resolved_at = now()` and `resolution_action_id = <action id>` in the same transaction | decide.ts:160-170; 0020:38-39. Consequences in section 5 |
| Stored: member reports | `reports` rows (reporter_id, post_id/comment_id, reason, created_at) carry no link to any action; the queue pairs them to rulings by timestamp comparison | migrations/0012_moderation.sql:26-40; moderation/queue.ts:86-112; auto-hide.ts:19-27 |
| Author email: facts relied on | The reason text verbatim under "Reason given by the reviewer:" | notify-author.ts:98 |
| Author email: notice vs own-initiative | Only the `keep_hidden:false` lead says "a report" (:58). No other string, and no field of `ModerationNotice`, carries it | notify-author.ts:25-33, :47-68 |
| Author email: notifier identity | NOT SENT. `ModerationNotice` has no reporter field; `notify-author.ts` contains no `reporter` identifier in `sendModerationNotice`. Control: `grep -n "reports\|reporter"` over notify-author.ts matches only the auto-hide comment at :108 ("never a reporter ..."), and the same grep over notify-reporter.ts finds 4 hits, so the pattern works | notify-author.ts:25-33, :108 |
| Admin route | `reason` required, `.trim()`ed, no maximum enforced at the route; the admin form sets `maxlength="2000"` | admin.ts:133, :154; web pages/admin/queue.astro:130 |
| Reporter-side data a moderator sees | DSA notice list shows reason, statement, reporter name and email, created_at | packages/shared/src/admin.ts:187-200 (`AdminDsaNotice`); dsa-notices.ts:161-186 |

### (c) Use of automated means

| | Fact | Cite |
|---|---|---|
| Automated hiding exists | At 3 distinct member reporters within 24 h, `maybeAutoHide` sets `hidden_at = now()` | auto-hide.ts:33, :53-97 |
| Stored: that a hide was automated | NOT RECORDED as an action. `maybeAutoHide` never calls `recordModerationAction`. Control: `grep -c recordModerationAction` gives 0 for auto-hide.ts and 2 for decide.ts (an import and a call). The only trace is `hidden_at` set with no `content_*` row after it (`hiddenReason` derives "moderation" for "an unresolved auto-hide (no visibility row at all yet)") | auto-hide.ts (0 hits); hidden-reason.ts:34-40, header :17-20 |
| Stored: any actor value "system" | The type admits `"system"` for automation but no content path writes it; the only `'system'` literal in code is a backfill of account holds | actions.ts:32; moderation/account-holds-backfill.ts:28 |
| Human decision guarantee in code | "Only a human writes a `content_*` action — automation never decides" (comment) | admin.ts:73 |
| Author email, auto-hide | Subject "Your content has been hidden pending review". Lead: "Your content has been hidden pending review." Body adds the content line, then: "A moderator will review it, and we will tell you the outcome. This is not a final decision, so there is nothing to appeal yet. If a moderator decides to keep it hidden, that message will tell you how to appeal." | notify-author.ts:122-134 |
| Author email, auto-hide, says automated? | NOT STATED. The copy does not say the hide was automatic, and deliberately omits reporter, reason, count and threshold ("The copy is fixed") | notify-author.ts:107-110 |
| Author email, moderator decision | No statement either way about automated means in `COPY`. Control: file contains the string "reviewed" at :49-65 (the human-review wording) and no "automat" | notify-author.ts:47-68; `grep -rniE automat` over moderation/*.ts and routes/admin*.ts hits only actions.ts:32, auto-hide.ts:23, admin.ts:73 (all comments) |
| Reporter email | States "This decision was made by a human moderator, in keeping with the Digital Services Act." Sent to DSA notifiers only | notify-reporter.ts:55-56, :62 |
| Whether any automated means assist the moderator (queue ordering) | The queue orders by a `SEVERITY_CASE` over report reason; not described to anyone outside the admin UI | moderation/queue.ts:71 |

### (d) Legal ground and explanation, where the content is alleged illegal

| | Fact | Cite |
|---|---|---|
| Stored: legal ground | NOT RECORDED as a distinct field. Closest columns: `violation_category` (one of 7 values, includes `ip_infringement`, `sexual`; the category is a bucket, not a statute or a ground) and free-text `reason` | 0013:24-25 |
| Stored: illegal vs terms-incompatible | NOT RECORDED. No column distinguishes the two, and `violation_category` is documented as "INTERNAL audit / DSA-transparency metadata ... Never shown to the author" | admin.ts:122-125; web pages/admin/queue.astro:133 ("internal ... not shown to the author") |
| Stored: legal hold | `account_legal_holds` row with a category and `moderation_action_id`, set only when the moderator ticks "Legal hold"; documented as never inferred from `violationCategory` | admin.ts:116-120, :157; decide.ts:172-182; migrations/0022_account_legal_holds.sql |
| Author email | No legal ground is named. The only ground phrase in any `COPY` lead is "it does not meet our Community Guidelines" (four of five keys). Control: `grep -niE "illegal|law|statute|unlawful"` over notify-author.ts finds no match, while the same file contains "Community Guidelines" at :54, :58, :62, :66, so the grep does read the lead strings | notify-author.ts:47-68 |
| Admin route | `violationCategory` optional; enum = `REPORT_REASONS`; 400 `INVALID_INPUT` if not in the list, and 400 if present with `decision = restore`. Merged in #175 (373e77f); the web form omits the field for restore | admin.ts:125, :136-138, :146; packages/shared/src/moderation.ts:9-19; web pages/admin/queue.astro:74-77, :89 |
| Whether a category is actually stored on existing rows | Every row written before #175 has NULL category (the route could not set it); the table is append-only so those rows cannot be corrected, only superseded by a new row | 0013:49-51; issue #57 item 2 |
| Appeal | `/appeal` shows the reason only; no category | packages/shared/src/admin.ts:242-249 (`AppealTarget` has `reason`, no category) |
| Reporter email | Mentions "the law" only in the restore lead: "decided it does not break our rules or the law, so no action was taken" | notify-reporter.ts:41-42 |

### (e) Contractual (terms) ground and explanation, where content is incompatible with the terms

| | Fact | Cite |
|---|---|---|
| Stored: which term / guideline / clause | NOT RECORDED. No column, and no table of guidelines or terms clauses. Control: the migration directory listing (0001-0025) has no table naming guidelines or terms, while it does have `dsa_notices`, `appeals`, `moderation_actions`, so a table of that kind would be in the list | apps/api/migrations/ (ls at the SHA) |
| Stored: free-text explanation | `reason` (see (b)) | 0013:30 |
| Author email | Only the generic phrase "does not meet our Community Guidelines" in four of five leads. No clause, no link to the guidelines, no mention of Terms of Service | notify-author.ts:54, :58, :62, :66 |
| Author email for `keep_hidden`/`remove` when decision was on a report | the lead is `keep_hidden:false`: "...hidden it because it does not meet our Community Guidelines." (same phrase) | notify-author.ts:58 |
| Where the guidelines text exists | `docs/legal/community-guidelines.md`, header "DRAFT (not in force; not reviewed by an attorney)" | docs/legal/community-guidelines.md:1 |
| Admin route | no field | admin.ts:112-125 |

### (f) Redress: internal complaint, out-of-court settlement, judicial

| | Fact | Cite |
|---|---|---|
| Internal complaint: stored | `appeals` row per action, UNIQUE (action_id); body text up to 5000 chars; outcome granted/denied; `resolution_action_id` points at an `appeal_granted`/`appeal_denied` row | migrations/0024_appeals.sql:12-30 |
| Internal complaint: what can be appealed | `content_keep_hidden`, `content_remove`, `user_warn`, `user_suspend`, `user_ban`. Not `content_restore`, not `user_terminate` | packages/shared/src/admin.ts:232-238 |
| Internal complaint: window | 30 days from the action's `created_at`, computed in SQL (`created_at > now() - make_interval(days => 30)`); refused with `APPEAL_WINDOW_CLOSED` (409) after | packages/shared/src/admin.ts:219; moderation/appeals.ts:37, :77; routes/appeals.ts:21 |
| Internal complaint: how an author reaches it | (1) token link in the notice email, token TTL equals the window (30 days), single use; (2) signed-in path `POST /appeals`; (3) `GET /appeals/for-post/:postId` for the editor banner, which returns a target only when the post is hidden and its latest `content_*` row is keep_hidden or remove | moderation/notice-links.ts:31-37; routes/appeals.ts:47-121, :123-170 |
| Internal complaint: in the email | "You can appeal this decision within 30 days: <url>" for keep_hidden and remove (never restore, never auto-hide). Link is omitted if token minting failed or the account is anonymised | notify-author.ts:88-92; admin.ts:196-205; notice-links.ts:1-10 |
| Internal complaint: who decides | A moderator resolves it; `sameReviewer` is computed and returned to the admin | routes/admin-appeals.ts:117-121; moderation/appeals.ts (`sameAdminHand`, imported :11) |
| Internal complaint: outcome to the appellant | Subject "Your appeal was granted" / "Your appeal was not granted"; body: lead, "Reason given by the moderator:", the reason. No further redress sentence | routes/admin-appeals.ts:102-110 |
| Out-of-court dispute settlement | NOT RECORDED and NOT MENTIONED in any email or page. Control: `grep -rniE "out-of-court\|dispute\|ombuds\|judicial\|court\|redress\|Art\. ?21"` over apps/api/src, apps/web/src, packages/shared/src returns one hit, a comment about "dispute their ban" at routes/delete-request.ts:3, while the same tree contains "appeal" in many files, so the grep does run | whole tree at the SHA |
| Judicial redress | NOT MENTIONED in any email or page (same grep) | same |
| Whether the email mentions the right to complain at all when there is no appeal link | NOT STATED: with no link the appeal sentence is simply absent | notify-author.ts:91 |
| Reporter-side redress | Reporters get no appeal link ("there is nothing for a reporter to appeal") | notify-reporter.ts:13-17 |

## 3. Account-level actions (warn / suspend / ban / terminate)

Route `POST /admin/accounts/:handle/action`, admin-accounts.ts:84-201; storage via `applyAccountAction`
(account-actions.ts:66-126); email `sendAccountActionNotice` (notify-account.ts:49-81).

| Element | Stored | Notice email | Cite |
|---|---|---|---|
| Kind | `moderation_actions.action` = `user_warn` / `user_suspend` / `user_ban` / `user_terminate`; user state: `users.suspended_until`, `users.disabled_at`, `users.disabled_reason` ('ban' or 'terminate') | Subject: warn "A warning about your account"; suspend "Your account has been suspended"; ban "Your account has been banned" | account-actions.ts:46-64; notify-account.ts:32-36; migrations/0015_user_account_status.sql:13-15 |
| (a) Effect text | n/a | warn: "A moderator has issued a warning on your account for breaking our Community Guidelines. Your account is not restricted." suspend: "Your account has been suspended for breaking our Community Guidelines. You will not be able to sign in until <UTC date>." ban: "Your account has been permanently banned for breaking our Community Guidelines. You will not be able to sign in again." | notify-account.ts:38-47 |
| (a) Duration | `moderation_actions.action_expires_at` = this action's own end (now + hours), and `users.suspended_until` = GREATEST over suspensions in force. Allowed hours: `SUSPENSION_HOURS`, default `DEFAULT_SUSPENSION_HOURS` | account-actions.ts:59-62, :91-117; admin-accounts.ts:106, :113 |
| (a) Duration in the notice | the effective end (`suspendedUntil`), which can be later than this action's own end | account-actions.ts:94-96; admin-accounts.ts:188 |
| (a) Territorial scope | NOT RECORDED, NOT STATED (account bars are global; no scope field) | account-actions.ts:59-64. Control: same file's SET_SQL holds `suspended_until` and `disabled_at`, the only state written |
| (b) Facts relied on | `reason` NOT NULL, `internal_note` NULL (not set by the route) | account-actions.ts:107-117; admin-accounts.ts:150-155 |
| (b) Prompted by notice / report | NOT RECORDED (same absence as content decisions; `AccountActionInput` has no such field) | account-actions.ts:26-39 |
| (b) In the notice | "Reason given by the moderator:" + reason | notify-account.ts:73-74 |
| (c) Automated means | NOT STATED, NOT RECORDED. Account actions are admin-initiated only | admin-accounts.ts:84-95; control: no `system` actor on a `user_*` row in code |
| (d)/(e) Ground | `violation_category` optional, same 7 values, 400 if outside list; not in the email. Ground phrase in email is "breaking our Community Guidelines" for all three | admin-accounts.ts:105, :112; notify-account.ts:41-45 |
| (f) Redress | appeal link (30 days) for warn/suspend/ban when minted; plus, for suspend and ban only, a deletion-request link and the sentence in `DELETE_REQUEST_SENTENCE_AFTER` | notify-account.ts:18-19, :53-67; notice-links.ts:31-37 |
| Barred user at sign-in | 403 `ACCOUNT_BARRED` with `{kind: "suspended", until, reason?}` or `{kind: "banned", reason?}`; reason read from the newest `user_ban` / `user_suspend` row | routes/login.ts:339-342; auth/account-status.ts:51-82 |
| Terminate (CSAM path) | `user_terminate` row written, `disabled_reason = 'terminate'`. NO notice is sent and the type does not admit one; the reason is withheld from the barred-login response by an in-memory check and an SQL `NOT EXISTS`. Whether a terminated user may be told why is the open legal question #114 | notify-account.ts:9-10, :22; account-status.ts:51-62 |
| No notice at all | Skipped when the account is anonymised (no one to tell) | admin-accounts.ts:170-171 |

## 4. Reporter-side notices (notify-reporter.ts)

Sent only to DSA-notice reporters whose confirmed notice a decision resolved (`dsaReporters`,
after-content-decision.ts:59-65) and, for an orphaned notice, by `POST /admin/dsa-notices/:id/close`
(admin.ts:407).

| Case | Subject | Text | Cite |
|---|---|---|---|
| Decision resolved the notice | "The content you reported has been reviewed" | Lead by decision: remove "We reviewed the content you reported and removed it."; keep_hidden "We reviewed the content you reported and it will stay hidden."; restore "We reviewed the content you reported and decided it does not break our rules or the law, so no action was taken." Then the content line, "Reason given by the moderator:", the reason, and "This decision was made by a human moderator, in keeping with the Digital Services Act." | notify-reporter.ts:38-63 |
| Content deleted by the author before review | "The content you reported has been removed" | "The content you reported was deleted by its author before a moderator reviewed it." + "This notice has been closed because there is no longer any content to review, in keeping with the Digital Services Act." | notify-reporter.ts:88-99 |

Facts against the Art. 17 elements, for the reporter email: it carries the moderator's reason verbatim; it states
human decision-making; it names no legal or contractual ground (the reason text is the only ground); it gives no
redress information; it does not say what the action was beyond "removed"/"stay hidden"/"no action"; it carries no
territorial scope or duration. Member reports (`reports`, not DSA notices) produce NO outcome email: `sendDsaOutcome`
has one call site, in the `dsaReporters` loop (after-content-decision.ts:61), and `dsaReporters` is built from
`dsa_notices` only (decide.ts:164-170). Control: `grep -rn "sendDsaOutcome"` over apps/api/src outside tests finds
exactly the definition and that call.

## 5. DSA notice intake as the "decision followed a notice" signal

| Question | Answer | Cite |
|---|---|---|
| What an intake stores | `reporter_email`, `reporter_name`, `good_faith` (CHECK true), `email_verified_at`, `verify_token_hash`, `target_kind`, `target_label` (title or first 120 chars, snapshot), `post_id` / `comment_id` (ON DELETE SET NULL), `reason` (same 7 values), `statement` (1..5000 chars), `created_at`, `resolved_at`, `resolution_action_id`, `closed_by` | migrations/0020_dsa_notices.sql:24-61 |
| Is the link from a decision to a notice stored? | Not on `moderation_actions` (see (b)). It is stored on the notice: `dsa_notices.resolution_action_id` = the deciding action's id, bare uuid, no FK | 0020:39; decide.ts:164-170 |
| Reverse query ("which notice did action X follow") | answerable only as `SELECT ... FROM dsa_notices WHERE resolution_action_id = $1`. Returns a row only if a confirmed, open notice existed on that content at decision time | decide.ts:165-168 |
| Cases where the link is absent although a notice existed | (1) The notice was unconfirmed at decision time: left inert, reaped after 7 days (`DSA_CONFIRM_WINDOW_DAYS`), never resolved by a ruling. (2) The notice arrived after the decision. (3) A second decision on the same content: the notice was already resolved by the first and `resolved_at IS NULL` no longer matches. (4) The notice was closed as orphaned: `resolved_at` set, `resolution_action_id` stays NULL, `closed_by` holds the moderator | decide.ts:160-163, :167; dsa-notices.ts:62, :128-137; 0020:39-47 |
| Cases where the link is present although the decision was not "because of" the notice | any confirmed open notice on the same content is resolved by whatever the decision is, restore included; the link says "this ruling answered the notice", not "the ruling was based on the notice" | decide.ts:160-170 |
| Member reports (`reports`) | No link to any action. Auto-hide excludes DSA notices by design ("AC-1") | dsa-notices.ts:2-3; migrations/0020:6-8; auto-hide.ts:19-27 |
| Notifier identity available to a moderator | Name and email (from the notice), in the admin list | dsa-notices.ts:161-186 |
| Notifier identity sent to the author | No | notify-author.ts:25-33 |
| DSA intake disclosure to the notifier | Confirmation email, then the outcome emails in section 4 | routes/dsa-notice.ts (intake); notify-reporter.ts |

## 6. Cross-cutting facts the attorney will want

1. **One `reason` string serves three audiences.** The same trimmed text is stored in `moderation_actions.reason`,
   mailed to the author, mailed to every resolved DSA notifier (admin.ts:154, :217; after-content-decision.ts:61),
   shown on `/appeal` (appeal.astro:184), and returned to a barred user at sign-in (account-status.ts:51-62). The
   admin form labels it "shown to the author and to anyone who filed a DSA notice about this content" (queue.astro:129).
2. **`violation_category` is internal by design** in code comments and the form label. It is never in any email or
   page listed above (controls in (d)).
3. **The author email does not vary by whether a notice existed.** `sendModerationNotice` is called with the same
   five fields for every non-dismissal result (admin.ts:211-219).
4. **Delivery is fire-and-forget.** A lost author notice is logged with the action id only (admin.ts:220-223); the
   durable-outbox design is the separate #57 gap 1 note (2026-10-14-moderation-notice-outbox-design.md).
5. **No author notice exists for these paths:** an anonymised author; a tombstoned comment (admin.ts:171-189);
   a `user_terminate`; an `author_hide` / `author_unhide` (the author's own act, no email); a `media_access` row.
6. **The statement the notice constitutes is not stored.** The email text is rebuilt from `COPY` at send time and
   not saved. If `COPY` changes later, the wording a past author actually received cannot be reproduced from the
   database; only `action`, `reason`, `created_at` survive. (Control: `notify-author.ts` contains no INSERT; the only
   writes in the send path are Postmark calls, :94-101.)
7. **What an author can see in-app** about why content is hidden: `hiddenReason` of `null` / `author` / `moderation`
   (hidden-reason.ts:34-40), the editor banner, and `/appeal` with action name, reason and window end
   (appeal.astro:181-186). The reason text is shown only on `/appeal` and in the email.

## 7. Open items that need a decision

Questions only. No wording is proposed and none is recommended. Costs are technical. Migration numbers are allocated
at gate time; the highest number on main at this SHA is 0025, and the outbox note records 0027 and 0028 as taken by
other work, so a number below is "next free", not a reservation. CireSnave applies migrations to production before
the PR merges.

| # | Question | Technical options and cost |
|---|---|---|
| 1 | Should a decision record whether it followed a notice (element b)? | (A) No schema change: derive from `dsa_notices.resolution_action_id` at read time; known holes in section 5 (unconfirmed, later, second decision, member reports). (B) Add nullable `moderation_actions.source` text or `dsa_notice_id` uuid plus a CHECK, set in `applyDecisionInTx` from the same `UPDATE ... RETURNING` that resolves notices (decide.ts:164-170): one migration, no backfill for old rows (append-only, so old rows stay NULL), an edit to `decide.ts`, `actions.ts`, tests. Member-report-prompted decisions would need a separate value because `reports` has no id link. |
| 2 | Should the email say the decision followed a notice, and may the notifier's identity be included (element b)? | Needs (1B) or the read-time join (1A) plumbed into `ModerationNotice` (notify-author.ts:25-33). The notifier's name and email are in `dsa_notices` but never reach the author path today; sending them is a privacy decision as well as a DSA one. |
| 3 | Do content decisions need a duration and a territorial scope (element a)? | Duration: `action_expires_at` already exists and is NULL for every content row; nothing reads it for content. Scope: no column; a new column or a fixed statement that restrictions are global, which the code currently makes true (hidden_at is global). Visible effect only if either is ever non-default. |
| 4 | How should automated means be disclosed (element c)? | Today an auto-hide produces no `moderation_actions` row and the notice does not say it was automatic. Options: (A) wording only, since the hide is already known to be automatic when `notifyAutoHidden` runs; (B) append a row with actor `system` and a new `action` value (extends the 0013/0017 CHECK, one migration, and several readers of `action LIKE 'content\_%'` need re-checking: auto-hide.ts:63, appeals.ts:25-31, queue.ts:86-88). (B) is the larger change and changes what "latest decision" means in `/appeals/for-post`. |
| 5 | Legal ground vs contractual ground (elements d, e): one field or two, and structured or free text? | Today: `violation_category` (internal, 7 buckets) and free text. A structured field needs a migration plus an admin-form control and an enum the attorney defines; a free-text template needs no schema change but is only as consistent as the moderator. |
| 6 | Should `violation_category` stay internal (it is labelled as such in code and in the admin form: admin.ts:122-125, queue.astro:133)? | If its meaning changes to something the author sees, the form label, the code comments and any transparency-report description change with it. Rows written before #175 are NULL permanently. |
| 7 | Is the Community Guidelines phrase sufficient as the "ground" string, given the guidelines document is a DRAFT not in force? | Nothing in code links a notice to a published document or version. A link or version stamp in the email is a copy change; a stored version needs a column. |
| 8 | Redress: which of internal complaint, out-of-court body, judicial remedy appear in which notice (element f)? | Internal complaint is implemented for keep_hidden, remove, warn, suspend, ban and appears in those emails when a link was minted. The other two appear nowhere. Copy-only change in `notify-author.ts`, `notify-account.ts`, `notify-reporter.ts`; the appeal outcome email (admin-appeals.ts:102-110) has no redress sentence either. |
| 9 | Should the exact text sent to the author be stored (section 6, item 6)? | Needs a store of the rendered subject and body per action: either a column on a new table or in the outbox row from the #57 gap 1 design (which would hold it anyway until sent). One migration; retention is a privacy question. |
| 10 | Should `restore` outcomes and `appeal_denied` outcomes be treated differently from adverse decisions for Art. 17 purposes? | A fact only: a restore sends an email when content had been hidden (notify-author.ts:48-51) but no appeal link, and an appeal outcome email contains only the lead and the moderator's reason. |
| 11 | Member `reports` (not DSA notices): is the member reporter owed an outcome? | None is sent today (section 4). Adding one needs the same plumbing as the DSA outcome plus a member-address read; `reports` has no resolution link, so a decision-to-report link would be a new migration. |
| 12 | The `terminate` path sends nothing and withholds the reason (#114). | Unchanged by any technical choice here; listed so this note's matrix is not read as covering it. |
