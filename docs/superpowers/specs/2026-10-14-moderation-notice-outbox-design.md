# A durable outbox for due-process notices — design note (issue #57, gap 1)

**Status:** DESIGN ONLY. No code. Written 2026-10-14 against `origin/main` 373e77f (0.1.20). Every `file:line` is at
that ref; re-read before building. **The implementation carries a migration that CireSnave applies to production
before it merges** (§6).

**Scope:** #57 gap 1, "no durable delivery". Gap 2 (violation category) shipped in #175. Gap 3 (Art. 17
contents) is legal wording and is a separate note.

## 1. What is lost today

Every due-process notice is sent once, from `ctx.waitUntil`, after the commit, and never retried:

| Notice | Where | Failure handling |
|---|---|---|
| Author, decision | `routes/admin.ts:211-224` | `console.error("moderation notice not sent", { actionId })` |
| Author, auto-hide | `routes/reports.ts:117` → `notify-author.ts` (`notifyAutoHidden`) | `console.error`, no retry |
| DSA reporter outcome (Art. 16(5)) | `moderation/after-content-decision.ts:61`, `routes/admin.ts:403-406` | `console.error("dsa outcome not sent", { noticeId, actionId })` |
| Appeal outcome | `routes/admin-appeals.ts:103-104` | none |
| Account action (warn/ban) | `moderation/notify-account.ts:49` via `admin-accounts.ts` | none |

`postmarkSend` never throws and returns `false` (`auth/postmark.ts:54-56`); the callers log and move on. A
Postmark outage, a Worker eviction between the commit and the `waitUntil`, or one 5xx therefore loses a notice
that the DSA obliges us to send "without undue delay". The log line makes it *findable* (R5), not *recoverable*.

What already exists and is reused: `postmarkSendOutcome` returning `{ ok, status, errorCode }`
(`postmark.ts:66`) and `classifyPostmark` → `sent | permanent | transient`
(`packages/shared/src/account-notices.ts:16`); the `*/2` cron tick (`index.ts:62-105`); the row-lease idiom of the
notification email drain (`notifications/email-drain.ts:86-110`, 300 s lease, an opaque owner token that fences
the release).

## 2. Decisions

### D1 — One generic table, written in the SAME transaction as the thing it announces

```sql
CREATE TABLE moderation_notice_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN
                    ('author_decision','author_auto_hide','dsa_reporter','appeal_outcome','account_action')),
  dedupe_key      text NOT NULL UNIQUE,
  action_id       uuid,            -- no FK: moderation_actions is append-only and never deleted from
  recipient_user_id uuid,          -- NULL for a DSA reporter, who is not a user
  recipient_email text,            -- ONLY when recipient_user_id IS NULL (a reporter's own address)
  payload         jsonb NOT NULL,  -- the rendered inputs, never an address for a user recipient
  created_at      timestamptz NOT NULL DEFAULT now(),
  available_at    timestamptz NOT NULL DEFAULT now(),
  claimed_by      text,
  claimed_until   timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  sent_at         timestamptz,
  skipped_at      timestamptz,
  skip_reason     text,
  dead_at         timestamptz,
  last_status     integer,         -- HTTP status of the last attempt, never a message body
  last_error_code integer,
  CONSTRAINT outbox_one_terminal_chk CHECK (num_nonnulls(sent_at, skipped_at, dead_at) <= 1)
);
CREATE INDEX moderation_notice_outbox_due_idx ON moderation_notice_outbox (available_at)
  WHERE sent_at IS NULL AND skipped_at IS NULL AND dead_at IS NULL;
```

- **`dedupe_key`** makes the insert idempotent and names the row: `decision:<actionId>:author`,
  `dsa:<noticeId>:<actionId>`, `autohide:<subject>:<subjectId>:<hiddenAt>`, `appeal:<appealId>:<outcome>`,
  `account:<actionId>`. `INSERT … ON CONFLICT (dedupe_key) DO NOTHING`.
- **Same transaction as the decision.** `applyDecisionInTx` already writes the audit row and resolves the DSA
  notices in one transaction (`decide.ts:127-149`); the outbox inserts join it. A decision can no longer commit
  without its notices queued, and a rolled-back decision queues nothing. This is the property the fire-and-forget
  path cannot have.
- **Auto-hide is one statement.** The report path runs on an autocommit connection (`reports.ts:77-95`), so the
  insert is a CTE: `WITH hidden AS (UPDATE posts SET hidden_at = now() WHERE id = $1 AND hidden_at IS NULL
  RETURNING id, author_id, hidden_at) INSERT INTO moderation_notice_outbox … SELECT … FROM hidden`. Atomic by
  construction; zero rows hidden means zero rows queued, which preserves "one notice per hide" (#174).
- **No address is stored for a user recipient.** It is resolved at send time by id (§D3). Only a DSA reporter,
  who has no user row, has an address stored.

### D2 — Send once immediately, then let the cron finish the job

The first attempt keeps today's latency and behaviour: after the commit, `ctx.waitUntil(sendNow(ids))`. Each
row is claimed with a row-level lease so a cron tick and a `waitUntil` cannot both send it:

```sql
UPDATE moderation_notice_outbox
   SET claimed_by = $owner, claimed_until = now() + interval '120 seconds', attempts = attempts + 1
 WHERE id = $1 AND sent_at IS NULL AND skipped_at IS NULL AND dead_at IS NULL
   AND available_at <= now() AND (claimed_until IS NULL OR claimed_until < now())
RETURNING *;
```

- On `sent`: `SET sent_at = now(), claimed_by = NULL, claimed_until = NULL … WHERE id = $1 AND claimed_by = $owner`
  (the owner fence from the email drain).
- On `transient`: `available_at = now() + backoff(attempts)`, release the claim. Backoff 2 min, 10 min, 1 h,
  6 h, 24 h.
- On `permanent` (`classifyPostmark`, e.g. an inactive recipient): `dead_at = now()`, no retry.
- After **8 attempts or 7 days**, `dead_at` as well, with one `console.error("moderation notice dead", …)` that
  carries `{ kind, actionId, attempts }` and no address.
- **A cron pass** on the existing `*/2` tick (`index.ts:99-105`, beside `runMediaBackfillBatch`): `SELECT … WHERE
  <due> ORDER BY available_at LIMIT 50`, claim each, send, stamp. Bounded per pass so a backlog cannot hold a
  tick. It must not throw out of `waitUntil` (the same rule as `email-drain.ts:70-76`).

### D3 — Eligibility is re-decided at send time, and a skip is a terminal state, not an error

Before each send the drain re-reads the recipient and the content and applies the rules shipped in #174:

- user recipient: `anonymised_at IS NOT NULL` → `skipped_at`, `skip_reason = 'author_anonymised'`, and the
  payload is scrubbed to `'{}'` (a title is the only thing in it that could identify a person);
- comment author deleted the comment, or the content is gone, or (auto-hide only) it is no longer hidden →
  `skipped_at` with the matching reason;
- DSA reporter: no eligibility rule beyond the address still being present.

This is what makes a notice that waited hours safe to send: the world may have changed.

### D4 — The appeal link is minted at send time

`mintActionToken` needs `anonymised_at IS NULL` and a TTL (`moderation/action-tokens.ts:40-50`). A notice
retried six hours later must not carry a token minted at decision time that has been burning its window while
undelivered. So the token is minted **inside the drain, immediately before the send**, with the normal TTL.
**Open question for CireSnave (§7, Q1):** whether the appeal window should start at the decision or at delivery.
This design makes "at delivery" the natural result and costs nothing to keep "at decision" instead (mint at
decision, store the URL in the payload).

### D5 — At-least-once, said plainly

If the Worker dies between Postmark's `200` and the `sent_at` stamp, the next pass resends. A duplicate
due-process email is harmless; a lost one is not, so the outbox chooses the duplicate. Each send carries
`X-TJ-Notice-Id: <outbox id>` (a Postmark custom header, `PostmarkMessage.headers`, `postmark.ts:80`), so a
duplicate is recognisable in Postmark's activity feed. No attempt is made at exactly-once: Postmark has no
idempotency key, and a lease cannot make a remote side effect transactional.

### D6 — A flag, off by default

`MODERATION_OUTBOX` (`"1"` is on, anything else off), a `vars` entry in `apps/api/wrangler.jsonc` shipped
`"0"`, read per request, exactly like the login-challenge flag. **Off is byte-for-byte today's behaviour:** no
row is written and the existing `waitUntil` sends run. This lets the migration ship and soak before any notice
depends on it, and gives an emergency switch that needs only an api change.

### D7 — Retention and erasure

| Row state | Kept | Why |
|---|---|---|
| `sent_at` | 30 days, then deleted by the daily reaper (`30 3 * * *`) | enough to answer "did they get it?"; the audit trail is `moderation_actions`, not the outbox |
| `skipped_at` | 30 days | same |
| `dead_at` | 90 days | an operator may need to re-send by hand |
| payload | scrubbed when skipped (anonymised); deleted with the row | titles and the reason text are the only free text |

The recipient's erasure path (`security/forget.ts`, `anonymise-accounts.ts`) needs one new statement: pending
rows for that user become `skipped` with the payload scrubbed. D3's send-time check already refuses a send to an
anonymised account, so this is cleanup, not the safety mechanism.

## 3. Alternatives rejected

- **Reuse `notifications` + the email drain.** That table "demands a human actor, forbids self-addressing, is
  suppressed by blocks and is silenceable via preferences — all four are wrong for a due-process notice"
  (`notify-author.ts:4-9`, the module's own rule). A second table is the honest answer.
- **A Durable Object queue.** More moving parts, no relational join to the decision, and the notices must be
  queryable by `action_id`.
- **Cloudflare Queues.** Not used anywhere in this repo today: it adds a binding and a second failure domain
  for something Postgres and a cron already do.
- **Retry inline with `await`.** Holds the admin response open on a third party.

## 4. What does not change

Notice copy and the `sendModerationNotice` / `sendAutoHideNotice` / `sendDsaOutcome` functions (the drain
calls them); `afterContentDecision`'s purge and media move; the decision's response bytes; who is told what.

## 5. Tests and the mutants they must kill (written first)

| # | Test | Mutant |
|---|---|---|
| T1 | a committed decision has exactly one `author_decision` row and one `dsa_reporter` row per resolved notice; a rolled-back decision has none | insert after the commit; insert outside the transaction |
| T2 | a failing Postmark (transient) leaves the row due with `available_at` advanced by the schedule; a later pass sends it and stamps `sent_at` | stamp before the send; no backoff |
| T3 | a permanent refusal sets `dead_at` and never retries | retry a permanent error |
| T4 | two concurrent claimers (a `waitUntil` and a cron tick) send once | drop `claimed_until`; drop the owner fence on the stamp |
| T5 | anonymised recipient / deleted comment / no-longer-hidden at send time → `skipped`, payload scrubbed, 0 sends | read eligibility at decision time |
| T6 | the appeal URL in a retried notice is minted at send time (a token row is created per send, not per decision) | mint at decision time |
| T7 | `ON CONFLICT (dedupe_key)`: replaying the same decision's insert adds nothing | no dedupe key |
| T8 | flag off: no row is written and the old `waitUntil` sends happen, byte for byte | any side effect when off |
| T9 | 8 attempts or 7 days → `dead_at` + one error line with no address | unbounded retry |
| T10 | a pass processes at most 50 rows and cannot throw out of `waitUntil` | unbounded batch; an unguarded SELECT |
| T11 | the reaper deletes `sent`/`skipped` rows past 30 days and `dead` past 90, and nothing pending | deleting an unsent row |
| T12 | no log line from the drain contains an address, a title or a reason | logging `payload` |

Each mutant is applied with an anchor-count assertion, must fail the named test, and is reverted.

## 6. Operator steps, and why this needs CireSnave

The migration adds one table and one index; it is **additive and backwards compatible** (the running code does not
know the table exists), so it **must be applied to production before the PR merges** (README "Deploying, Merge
rule"; `docs/runbooks/deploy.md`), exactly like 0027.

1. The PR carries the migration (the next free number after what is in flight, never lower than production has
   applied; at this ref 0027 is #161's, 0028 is reserved for the media-ownership work).
2. **CireSnave applies it** with the runbook's migrate command. Nothing in a lane may touch production.
3. Merge. The flag ships `"0"`, so nothing changes until it is turned on.
4. Turn the flag on in a one-line PR (or the break-glass `--var`), watch one decision and one auto-hide land in
   the table and send, then leave it on.
5. Rollback: flag off. The table can stay.

## 7. Open questions for CireSnave (through the PM)

- **Q1.** Does the appeal window start at the decision or at delivery of the notice? (D4. Recommend delivery:
  a person cannot appeal what they never received.)
- **Q2.** Retention: 30 days for sent/skipped, 90 for dead. Acceptable, or shorter?
- **Q3.** Scope for v1: all five kinds, or the author decision and the DSA reporter outcome first (the two with a
  statutory clock)? Recommend all five in one table but two PRs: the table + the two statutory kinds, then the
  rest.
