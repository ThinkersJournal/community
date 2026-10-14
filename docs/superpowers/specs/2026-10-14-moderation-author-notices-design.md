# Moderation author notices — design and plan (issues #138, #135, #56)

**Status:** DESIGN AND PLAN. No code. Written 2026-10-14 against `origin/main` 7caf172 (0.1.14). Every `file:line` is
at that ref; re-read before building. Ranked by the PM 2026-10-14 as one piece of work.

**One sentence:** the author notice is sent when, and only when, there is an author who can receive it and a
decision or hide that concerns them. Two cases send a notice that must not go (#138 an anonymised author, #135 a
tombstoned comment), and one case sends none that should (#56 an auto-hide).

## 1. What the code does at 7caf172

| Fact | Where |
|---|---|
| `POST /admin/decision` applies the decision, then sends the author notice for **every** non-dismissal result | `routes/admin.ts:141-198`, notice at `:182-195` |
| The author's address is `u.email` read in the same `UPDATE … FROM users u … RETURNING` | `moderation/decide.ts:96-106` (post), `:108-118` (comment) |
| After anonymisation `users.email` is `deleted-<id>@invalid.thinkersjournal.local`, and `anonymised_at` is set | `auth/anonymise-accounts.ts:68, 224` |
| The comment branch has no `deleted_at` predicate, so a tombstone (`deleted_at` set, `body_markdown = ''`) matches like a live comment | `decide.ts:109-115`; tombstone written at `routes/comments.ts:309` |
| `sendModerationNotice` has exactly one caller, and no bounce handling beyond `postmarkSend` logging | `routes/admin.ts:182`; `notify-author.ts:68-100` |
| `maybeAutoHide` hides at 3 distinct reporters in 24 h and returns only a `PurgeTarget` (post id, author id, tag slugs, or the parent post id for a comment) | `moderation/auto-hide.ts:37-73` |
| `POST /reports` purges after the hide and sends nothing | `routes/reports.ts:91, 108` |
| Appeals use `applyDecisionInTx` for a *restore* and notify the appellant themselves, not through `sendModerationNotice` | `moderation/appeals.ts:180`, `after-content-decision.ts:9` |
| A test documents the current wrong behaviour for a tombstone: "deciding on a tombstoned comment DOES email its author" | `test/admin-dsa-notices.test.ts:420-423` |

## 2. Decisions

### D1 — One decision-time flag, computed where the row is already read (fixes #138 and #135)

`applyDecisionInTx` already selects the author row. Extend both `RETURNING` lists, no second query:

- posts: `(u.anonymised_at IS NOT NULL) AS author_anonymised`
- comments: the same, plus `(t.deleted_at IS NOT NULL) AS tombstoned`

`DecisionResult` gains one field:

```ts
readonly noticeSkip: "author_anonymised" | "comment_deleted" | null;
```

`"author_anonymised"` wins when both are true (the stronger fact, and the one that explains the sentinel).
`authorEmail` stays on the result (the audit row's `subjectLabel` already uses it; nothing else changes).

**Why the column and not the address shape:** `anonymised_at` is what the notification email drain already gates on
(#138's own text), so there is one definition of "this account is gone". A `LIKE '%@invalid.%'` test would be a
second definition that rots.

### D2 — The decision is still applied and recorded; only the notice is skipped (#135 option (a))

The audit row, the legal hold, the cache purge, the media move and the **DSA reporters' outcome emails** are all
unchanged: Art. 16(5)/17 owes the reporter an outcome whatever happened to the content (design
`2026-09-06-m4-moderation-queue-design.md` ruling, 2026-10-01). Refusing with 409 (option (b)) would make a legal
hold on an anonymised account's content impossible to record, which is the reason the decision must still apply.
`routes/admin.ts` gates **both** the appeal-link mint (`:166-178`) and the send (`:182`) on `noticeSkip === null`,
so a skipped notice also skips the token mint, which is wasted work and an unused credential.

A skip writes one structured line, `moderation notice skipped`, with `{ actionId, reason }` and nothing else. It
carries no address, no title, no author id.

### D3 — An auto-hide sends one notice, with no appeal link (#56)

- `maybeAutoHide` returns `{ purge, subject, subjectId, authorId } | null` instead of a bare `PurgeTarget`
  (callers: `reports.ts:91` only). It still returns `null` when nothing was hidden (`auto-hide.ts:61, 70`), so
  **exactly one notice per hide event** and none on later reports against already-hidden content.
- `reports.ts` sends it **after the commit and the purge**, through `ctx.waitUntil`, exactly like the decision
  notice (`admin.ts:182`): a mail outage must never fail a recorded report.
- The recipient is read **at send time**, not carried through the report transaction: one `SELECT u.email,
  u.anonymised_at, p.title [, c.deleted_at]` on `HYPERDRIVE_FRESH`. Anonymised or tombstoned → no send, same
  `moderation notice skipped` line with reason `auto_hide_author_anonymised` / `auto_hide_comment_deleted`.
  Reading at send time also means a notice for content the author deleted in the meantime is not sent.
- **No appeal link.** There is no `moderation_actions` row yet, and an appeal attaches to a decision
  (`noticeLinks({ actionId, … })`, `admin.ts:170`). The copy says what is true: the content is hidden **pending
  review**, a moderator will review it, and the author will be told the outcome (which will carry the appeal
  link). Reuse `sendModerationNotice`'s module and stream (`"outbound"`, no unsubscribe) with a new kind rather
  than a second email path, as the issue asks: `notify-author.ts` gains a `sendAutoHideNotice` beside it, sharing
  `escapeHtml`, `postmarkSend` and the copy table's shape.
- **What the notice never contains:** the reporters' identities, their count, the report reasons, or any text from
  a report. The three-reporter threshold is not disclosed either, because disclosing it hands an attacker the
  number. Fixed copy plus the author's own post title (or "your comment on <post title>").
- **Abuse:** three accounts can cause one email to a victim per hide. The content is hidden at the same moment, so
  the email reports something that did happen, the copy is fixed, and #55's cut-off means a re-hide needs three
  *new* reports after a human restored it. No new limiter.

### D4 — Not changed

- `restore` of never-hidden content stays a dismissal with no notice (`notify-author.ts:77`).
- The appeal outcome emails (`admin-appeals.ts`) are untouched: an anonymised account cannot appeal.
- `sendModerationNotice`'s signature and copy are unchanged; the gate is in the route, so the existing
  `notify-author` unit tests keep passing unmodified.
- No migration. No new binding. No change to a rate limit.

## 3. Tasks (test-first; each step is one commit, one reviewer pass)

**Process:** Sonnet implementer → Sonnet reviewer with the checklist in §5 → adjudicate; every subagent gets
`model: "sonnet"`. Tests on `thinkersjournal_test_appeals` only; never create, drop or alter a database.

### T1 — `decide.ts`: the flag
- [ ] **Failing tests** (`test/moderation-decide.*`, with the existing fixture helpers): post by an anonymised
  author → `noticeSkip: "author_anonymised"`; comment by an anonymised author → same; tombstoned comment, live
  author → `"comment_deleted"`; both → `"author_anonymised"`; live post, live comment → `null`. Each of the three
  decisions (`restore`, `keep_hidden`, `remove`) for one case, so the flag is not decision-dependent.
- [ ] Implement D1. **Mutants:** drop the `anonymised_at` term; drop the `deleted_at` term; swap the precedence.
- [ ] Control: the same tests still see `authorEmail` populated, so a "skip" is not "no row".

### T2 — `admin.ts`: gate the notice and the mint
- [ ] **Failing tests** (`test/admin-decision-route.test.ts` style, `postmarkSend` stubbed): anonymised author →
  decision `200`, `moderation_actions` row present, **0** author sends, **0** appeal-token mints, the DSA reporter
  still sent; tombstoned comment → same; live author → exactly the sends of main (the characterisation test,
  written first and green on main).
- [ ] **Update** `test/admin-dsa-notices.test.ts:420-423`: the "DOES email its author" documentation test becomes
  the regression test for #135 (it asserts the opposite and says why).
- [ ] Implement D2. **Mutants:** gate only the send, not the mint; skip the DSA reporter too; skip recording the
  action when `noticeSkip !== null`; invert the gate.

### T3 — auto-hide notice
- [ ] **Failing tests** (`test/reports-route.test.ts` style): reports 1 and 2 → 0 sends; the 3rd distinct reporter
  → the post is hidden **and** exactly one send, to the author, `outbound` stream, no link, copy contains
  "pending review"; the 4th report on already-hidden content → still 1 send total; a comment target → comment
  copy naming the parent post; anonymised author → 0 sends and the skip line; tombstoned comment → 0 sends;
  the body never contains a reporter id, reason or count (assert over the full text and HTML); a Postmark
  failure → `POST /reports` still `201`.
- [ ] Implement D3. **Mutants:** send on every report; send before the commit (assert ordering through the call
  log); include the appeal link; read the recipient from the transaction snapshot instead of at send time (a test
  that deletes the comment between the hide and the send); include the report reason.

### T4 — docs
- [ ] `2026-09-06-m4-moderation-queue-design.md` §4.4 second bullet: "built in <PR>", with the no-appeal-link
  note. Close out in the PR body what each issue's acceptance is; **never** put a close keyword next to a number
  (the repo's own rule): list the three issue numbers as "Part of".

## 4. Version, migration, rollout

No migration, no operator step, no flag: the change is three small route edits behind existing behaviour. It is
safe to deploy in any order. The PM allocates the version at the gate; the work is one PR (T1–T4), or three if the
reviewer prefers smaller diffs (T1+T2 are inseparable).

## 5. Reviewer checklist

1. Is `noticeSkip` computed from the row the decision actually wrote, in the same statement, with no second read
   that could disagree?
2. Does any path still send to an address ending `@invalid.thinkersjournal.local`? (grep the whole send surface,
   not only `admin.ts`: `notify-account.ts`, `appeals`, the email drain.)
3. Is every other consequence of a decision on a skipped notice unchanged: audit row, hold, purge, media, DSA?
4. Can a tombstone decision leak the tombstone's emptied body or the author's address into a log line?
5. Auto-hide: exactly once per hide; after the commit; never fails the report; no reporter-derived text; no
   appeal link for a decision that does not exist yet; read at send time.
6. Are the new log lines free of addresses, titles and author ids?
7. Do the characterisation tests pass **unmodified on main** (they must, or they characterise nothing)?
