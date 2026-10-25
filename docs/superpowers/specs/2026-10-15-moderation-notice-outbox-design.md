# Moderation notice outbox — design (board 194, #57 gap 1)

Status: DESIGN ONLY, no code. Rulings are CireSnave's, verbatim via the PM (2026-10-15):
"Q1: Delivery. Q2: Make the configurable constant one year unless there is legal reason to keep them
longer. Q3: What notice types exist? F4: They should always have the option to email us at
dispute@thinkersjournal.com whether they have a token or not." Q3 then ruled: "Agreed.  1-5."

## 1. Problem today
Notices are rendered and sent best-effort under `ctx.waitUntil` AFTER the decision commits
(`routes/admin.ts`, `routes/admin-accounts.ts`, `routes/admin-appeals.ts`, `after-content-decision.ts`). A
Postmark outage or a worker eviction loses the notice; the log line is the only trace. The appeal window
(`APPEAL_WINDOW_DAYS`, `appeals.ts loadAction`) and the appeal token TTL (`notice-links.ts`) both run from the
DECISION, so a lost or late notice silently burns the user's window. `moderation_notice_records` (0032) keeps what
was sent, but only for sends that happened.

## 2. Notice types (v1 = 1-5, ruled; 6 and 7 are not designed here and not built)
| # | `kind` | Recipient | Trigger | Appeal link? |
|---|---|---|---|---|
| 1 | `author_decision` | content author | content keep_hidden / remove / restore-of-hidden | yes (not restore) |
| 2 | `author_auto_hide` | content author | `content_auto_hide` system row | no in the code: "nothing to appeal yet" (`notify-author.ts`); the outcome notice carries the link |
| 3 | `account_action` | the account | warn / suspend / ban / terminate | yes (terminate: no; see #114 text) |
| 4 | `appeal_outcome` | appellant | `appeal_granted` / `appeal_denied` | no |
| 5 | `reporter_outcome` | DSA reporter (an address, maybe no account) | outcome of a confirmed notice | no |

Anonymised recipient: no row is written (same as today's `noticeSkip`).

## 3. Table (next free migration number at gate, 0033+; the PM applies it before merge)
`moderation_notice_outbox`:
`id uuid pk`, `action_id uuid not null` (no FK, matching 0013/0032), `kind text CHECK in the five`,
`recipient_user_id uuid null` (null for a reporter), `recipient_email text null` (reporters only; accounts are
re-read at send time, see 6), `subject`, `body_text`, `body_html`,
`state text CHECK (pending | sending | delivered | undeliverable)`, `attempts int`, `next_attempt_at`,
`leased_until`, `leased_by` (same lease shape as `email_drain_lock`/0008), `created_at`,
`delivered_at timestamptz null`, `last_error text null` (class only, never a body or address),
`retain_until timestamptz not null`. `UNIQUE (action_id, kind)`: a retried enqueue is a no-op.
Partial index on `(next_attempt_at) WHERE state IN ('pending','sending')`; index on `retain_until`.

The outbox row IS the notice record: it supersedes `moderation_notice_records` (0032). The implementation PR
keeps 0032's table read-only until its own `retain_until` has passed, then drops it; the daily purge cron step
purges both meanwhile. Migration files carry the `-- Up Migration` / `-- Down Migration` markers.

## 4. Enqueue is atomic with the decision
The notice is rendered and INSERTed **inside the decision's transaction** (decide.ts / account action / appeal
resolve), so "decision committed" implies "notice queued". Appeal tokens are minted in that same transaction.
No post-commit mint or `waitUntil` send. A render failure rolls the decision back — deliberately: an
unannounceable decision is the exact Art. 17 failure being closed.

## 5. Q1 — window starts at DELIVERY
- `delivered_at` is stamped when the provider accepts the message (HTTP 2xx), in the same UPDATE that moves the
  row to `delivered`. It is NOT inbox delivery; bounce-webhook refinement is out of scope.
- Appeal window = `delivered_at + APPEAL_WINDOW_DAYS`. `loadAction`'s `in_window` and
  `AppealTarget.windowClosesAt` read the outbox row (join on `action_id`, kinds 1-3).
- Token: minted with a provisional `expires_at = created_at + undeliverable horizon (7 d) + window`; the delivery
  UPDATE rewrites it to `delivered_at + window`. The stored body keeps the raw link only until delivery; the same
  UPDATE replaces the link in the retained `body_text`/`body_html` with a "[link removed after delivery]" marker
  (a record must not hold a live credential).
- **A decision that is never delivered** (state `undeliverable` after the retry horizon of 7 days, or a permanent
  recipient error): the window **does not start**, the decision stays in force, and the matter becomes a human
  one: (a) it appears in an admin "undelivered notices" list with a Resend action (a resend returns the row to
  `pending`, mints a fresh token, and the window starts on that delivery); (b) the account owner's logged-in
  session path may still appeal (it never needed the token); (c) the dispute@ address (section 8) always works.
  The never-delivered window is still bounded by retention: it closes at `decision + 365 d`, when the record is purged.

## 6. Delivery
- The existing `*/2 * * * *` cron drains it (same shape as the email drain and the CSAM outbox design): lease a
  bounded batch with an atomic conditional UPDATE, send, then stamp. Backoff 2 m, 10 m, 1 h, 6 h, 24 h, 24 h, then
  `undeliverable`. 4xx recipient errors (inactive/invalid address) are permanent at once; 5xx/timeouts retry.
- Account recipients' address is re-read from `users` at send time (an address change between decision and send
  is honoured; an anonymised account becomes `undeliverable` with no send). Reporter addresses are stored on the
  row and nulled when it reaches `delivered` or `undeliverable`.
- Logs: counts by state only. Never a body, title, reason or address in a log line.

## 7. Q2 — retention: one configurable constant, default 365 days
`MODERATION_NOTICE_RETENTION_DAYS` (packages/shared/src/admin.ts) goes 730 → **365** (#193 shipped 730 as
provisional); `retain_until` = decision's `created_at` + constant, fixed at write time. Legal reason to keep longer:
**none found**. DSA Art. 17 imposes no retention duty on the statement text; Art. 24(5)'s transparency-database
submission is not retention of this table and carries no personal data; GDPR Art. 5(1)(e) points the other way.
Art. 20(1)'s complaint-access period (section 9) is satisfied by 365 d. A later legal finding is one constant.

## 8. F4 — dispute@ in EVERY notice, with or without a token
A shared `DISPUTE_CONTACT_LINE` (built on `DISPUTE_EMAIL`, packages/shared/src/contact.ts) is appended to all five
kinds and to the termination notice, in text and HTML, whether or not an appeal link is present; the `/appeal` page
shows it too (valid token, expired token, no token). One pin test per kind, mutation-checked. Reporter outcomes
(kind 5) carry it as well.

## 9. Flag for CireSnave (not decided here)
DSA Art. 20(1) requires the internal complaint system to be available "for a period of at least six months
following the decision". `APPEAL_WINDOW_DAYS` is **30**. Starting at delivery only lengthens the window, but 30 days
after delivery is still under six months. This needs a ruling on the window length (the constant plus the "within N
days" copy in notices and guidelines); this note changes nothing there.

## 10. Build order
Implementation PRs, each with a version at gate: (1) migration + enqueue in the content-decision path + drain;
(2) account / appeal-outcome / reporter kinds; (3) admin undelivered list + resend; (4) window-from-delivery switch
in `appeals.ts`, last, so no flow reads a `delivered_at` that is never written.
