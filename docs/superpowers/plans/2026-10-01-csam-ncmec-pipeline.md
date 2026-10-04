# CSAM Detection → NCMEC Reporting Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a detection (a Cloudflare or self-scan known-hash match, or a future classifier flag) or a moderator's sighting enters the system, the matched content is quarantined at once, the evidence is preserved from that moment, the uploader's account **stays active** (R1), a priority review case opens with an URGENT alarm, and, for a known-hash match, a CyberTipline report is filed automatically within about 2 minutes ("Option B"). A moderator's CONFIRM terminates the uploader and queues any report not yet queued; a CLEAR lifts the quarantine. Any report that doesn't reach "filed", and any case nobody has decided, raises an alarm.

**Architecture:** One intake transaction writes every local consequence (quarantine, holds, snapshots, the case and its alarm) and, for a known-hash match, queues one `ncmec_reports` row per uploader. A CONFIRM or CLEAR is one more transaction. The existing `*/2 * * * *` cron drains those rows through NCMEC's ISP Web Services (submit → upload → fileinfo → finish) as a persisted state machine, resubmitting when NCMEC's deletion window has passed. Alarm conditions are computed from the same tables and surfaced in three ways: a red banner on every admin page, an email, and a log line.

**Tech Stack:** TypeScript on Cloudflare Workers (`apps/api`), Astro SSR (`apps/web`), Postgres via Hyperdrive, R2 (`MEDIA`, `MEDIA_RESTRICTED`), `fast-xml-parser` (exact pin), vitest (pool + Node projects), Postmark "outbound".

**Spec:** `docs/superpowers/specs/2026-10-01-csam-reporting-pipeline-design.md` (PR #130, approved by the PM; **revision 1**, 2026-10-04, applies R1 and "Option B" and needs the PM's approval again) and its research notes, `docs/superpowers/specs/2026-10-01-ncmec-research-notes.md`. **Read both.** Every "§n" below refers to the spec.

## Preconditions (do not start Task 1 until all hold)

Checked against `origin/main` at `9a76b6f` (0.1.4) on 2026-10-04:
- Plan A (#132) is merged: `applyAccountAction` (`apps/api/src/moderation/account-actions.ts:66`) and the account routes exist.
- Plan B (#144) is merged: `applyDecisionInTx` (`decide.ts:90`) and `afterContentDecision` (`after-content-decision.ts:29`) exist. ⚠️ `afterContentDecision`'s `legalHold` is `{ category, imposedBy }` (`:26`); it fills `moderationActionId` from `result.actionId` itself (`:50-53`), and the args also need `decision` and `reason`.
- #126 is merged (`moderation_snapshots`, `0021`). The account legal hold (#139) is merged: `imposeAccountHoldInTx` (`account-holds.ts:98`), and holds gate both reapers. #141's `RESERVED_EMAIL_KEY` HMAC (`0023`) and #145 (`0025`) are merged; nothing here touches them.
- `clientIp()` exists (`apps/api/src/http/client-ip.ts:23`) and is used only for rate-limiter keys; no IP is stored, so the report still carries none (spec §4.5).
- The migration below is **`0026_csam.sql`** (the last on main is `0025_drop_reserved_email_sha256.sql`). If another migration lands first, take the next free number.
- **The NCMEC credentials exist** (exttest at least). The implementation PRs wait for them.

## Global Constraints

- TypeScript **6.0.3**. Errors go through `errorResponse` and the closed `ApiErrorCode` union.
- Admin routes: `checkOrigin` first (POST), then `requireAdmin`. Each new admin POST is added to `apps/api/test/helpers/pipeline-exempt.ts` with a reason.
- **R1: no machine detection bars anyone** (`CSAM_BAR_UNREVIEWED_MATCH = false`; AC-C14). Only a moderator's CONFIRM (or a moderator's own sighting) terminates.
- **"Option B": for a known-hash match, no human action between intake and NCMEC `submit`** (`CSAM_REPORT_AT_MATCH = true`; AC-C2). A **classifier** flag is never reported before CONFIRM, under either value.
- **No email to the uploader or author from any CSAM path** (A3; AC-C7).
- **The exact bytes sent to NCMEC are preserved for at least a year**, append-only, with no reaper (§2258A(h); spec §5).
- XML responses: **byte cap before parse**. `fast-xml-parser` is pinned **exactly** (no `^`), and the characterisation test passes against that pin (AC-C12). Request XML is built with an escaper, never parsed.
- Secrets `NCMEC_USERNAME`, `NCMEC_PASSWORD`, `NCMEC_REPORTER_NAME`, `NCMEC_REPORTER_EMAIL`, `NCMEC_REPORTER_PHONE`, `NCMEC_REPORTER_ADDRESS`, `CSAM_ALARM_EMAIL`; var `NCMEC_BASE_URL`, with **no default**. All are **supplied by the operator as secrets**. ⚠️ **Never write a real name, email, phone or address into code, tests, docs, commits or PR text**; tests use obviously fake values (`reporter@example.test`). If any NCMEC value is missing or blank, the system is "not configured" and reports sit in `awaiting_credentials`, which alarms.
- `CSAM_BAR_UNREVIEWED_MATCH = false` and `CSAM_REPORT_AT_MATCH = true` are code constants in `apps/api/src/csam/config.ts`, each above CireSnave's verbatim ruling (spec §3.4). **No PR that sets them merges unless both equal his quoted words, quoted in the PR** (AC-C6).
- A CSAM **account** hold is never released by app code (`account-holds.ts:162`). A CSAM **media** hold is released only by a two-person CLEAR (Task 9), which first makes a held evidence copy.
- Every PR body says **"Part of #114"**. Only the last PR, which carries AC-C8's exttest evidence, uses GitHub's closing keyword for the issue.

## Review Focus

1. **A batch whose keys are all suppressed** (a moderator pastes yesterday's email twice, or a cleared file is re-detected). There must be no new case, report, hold or alarm, and the response must name the existing case (AC-C10). Pinned in Task 6.
2. **An orphan upload** (a matched image no post embeds). It must still leave the public bucket (AC-C9). Pinned in Task 6.
3. **A multi-uploader image** (dedup): each uploader's report must carry only that uploader's files (AC-C11). Pinned in Task 6.
4. **NCMEC silently deleting a half-filed report** (the drain stalls past 24 h/1 h). It must be resubmitted fresh, with the old id kept (AC-C3). Pinned in Task 7.
5. **Credentials NCMEC rejects** (`2000`/`3100`) must alarm on the very tick they occur, not 6 h later (§6 condition 5). Pinned in Task 8.
6. **Quarantine without a bar** (AC-C14): after an unreviewed match the uploader's `disabled_at`/`disabled_reason`/`suspended_until` are unchanged and they can still log in and post, while the matched media 404s everywhere except the two-person restricted route. A classifier case queues no report. Pinned in Task 6.
7. **The clear path** (AC-C15): restore, evidence copy, hold archived, unsubmitted report withdrawn with no NCMEC call, submitted one retracted, finished one kept, no re-alarm on re-detection. Pinned in Task 9 (and the retract in Task 7).
8. **Escalation** (AC-C16): URGENT at the match, again every `CSAM_ALARM_REPEAT_HOURS`, `OVERDUE` after `CSAM_REVIEW_TARGET_HOURS`, and no timer ever bars or clears. Pinned in Task 8.
9. **The two pre-existing gaps** (spec §3.7, §5): a re-upload of a held file must not reach the public bucket (AC-C17), and the orphan reaper must not delete a held key's `media` rows. Pinned in Task 2a.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/api/src/media/key-pattern.ts` (modify) | The one media-key pattern (SQL + JS), plus `sha256FromMatchInput`. |
| `apps/api/src/media/reachability.ts`, `reap-orphan-media.ts` (modify) | Use the shared pattern; drop their private copies. |
| `apps/api/src/moderation/account-actions.ts` (modify) | Split out `applyAccountActionInTx`. |
| `apps/api/src/media/reap-orphan-media.ts`, `apps/api/src/routes/media.ts` (modify) | Task 2a: skip held keys in the reaper; refuse a held key on upload. |
| `apps/api/migrations/0026_csam.sql` (create) | The `csam_hold`/`csam_review`/`csam_clear_release` action kinds; `csam_cases`, `csam_case_files`, `csam_case_targets`, `csam_upload_attempts`, `ncmec_reports`, `ncmec_report_files`, `ncmec_submissions`, `media_legal_hold_releases`. |
| `apps/api/src/csam/config.ts` (create) | `CSAM_BAR_UNREVIEWED_MATCH`, `CSAM_REPORT_AT_MATCH`, the review/escalation constants, timing constants. No contact values: those are secrets. |
| `apps/api/src/csam/ncmec-xml.ts` (create) | Build report/fileDetails XML; parse responses under a byte cap. |
| `apps/api/src/csam/ncmec-client.ts` (create) | The HTTP calls: submit, upload, fileinfo, finish, retract, status. |
| `apps/api/src/csam/intake.ts` (create) | The intake transaction and its post-commit steps. |
| `apps/api/src/csam/drain.ts` (create) | The cron drain state machine. |
| `apps/api/src/csam/alarms.ts` (create) | Alarm conditions, the case escalation, and the alarm emails. |
| `apps/api/src/csam/review.ts` (create) | CONFIRM, the two-person CLEAR, retry. |
| `apps/api/src/routes/admin-csam.ts` (create) | The admin routes. |
| `apps/web/src/pages/admin/csam.astro` (create) + admin layout banner | The UI. |
| `docs/runbooks/csam.md` (create) | The manual steps. |
| `apps/api/scripts/ncmec-exttest.mjs` (create) | AC-C8's end-to-end run. |

---

### Task 1: One media-key helper

**Files:** modify `apps/api/src/media/key-pattern.ts`, `apps/api/src/media/reachability.ts`, `apps/api/src/media/reap-orphan-media.ts`; test `apps/api/test/key-pattern.node.test.ts`.

**Produces:** `MEDIA_KEY_SQL_PATTERN` (unchanged value), `sha256FromMatchInput(line: string): string | null`, `sha256sInMarkdown(markdown: string): string[]`.

- [ ] **Step 1: Failing test** (`key-pattern.node.test.ts`, Node project):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MEDIA_KEY_SQL_PATTERN, sha256FromMatchInput, sha256sInMarkdown } from "../src/media/key-pattern";

const SHA = "a".repeat(64);

describe("sha256FromMatchInput", () => {
  it.each([
    [SHA, SHA],
    [`  ${SHA.toUpperCase()}  `, SHA],
    [`https://cdn.thinkersjournal.com/media/post/${SHA}.webp`, SHA],
    [`cdn.example.org/media/post/${SHA}.webp?x=1`, SHA],
    [`media/post/${SHA}.webp`, SHA],
  ])("%s → the sha256", (input, want) => expect(sha256FromMatchInput(input)).toBe(want));

  it.each(["", "hello", "a".repeat(63), `media/post/${"a".repeat(63)}.webp`, `media/avatar/${SHA}.webp`])(
    "%j → null (reported back as unrecognised)",
    (input) => expect(sha256FromMatchInput(input)).toBeNull(),
  );
});

describe("sha256sInMarkdown", () => {
  it("finds every embedded key, deduplicated, in order of first appearance", () => {
    const b = "b".repeat(64);
    const md = `![](https://cdn.thinkersjournal.com/media/post/${SHA}.webp) x ![](/media/post/${b}.webp) ![](/media/post/${SHA}.webp)`;
    expect(sha256sInMarkdown(md)).toEqual([SHA, b]);
  });
});

describe("one pattern, not three copies (spec §3.2)", () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, "..", "src", "media", f), "utf8");
  it("reachability.ts and reap-orphan-media.ts use MEDIA_KEY_SQL_PATTERN and carry no literal copy", () => {
    for (const f of ["reachability.ts", "reap-orphan-media.ts"]) {
      expect(src(f)).toContain("MEDIA_KEY_SQL_PATTERN");
      expect(src(f)).not.toContain("([0-9a-f]{64})");
    }
  });
  it("the SQL pattern value is unchanged", () => {
    expect(MEDIA_KEY_SQL_PATTERN).toBe("media/post/([0-9a-f]{64})\\.webp");
  });
});
```

- [ ] **Step 2:** `cd apps/api && npx vitest run test/key-pattern.node.test.ts` → FAIL (missing exports; the copies are still present).
- [ ] **Step 3: Implement.** In `key-pattern.ts`, keep `MEDIA_KEY_SQL_PATTERN` and `r2KeyForSha256`, correct the header comment so it lists the real users (reachability, reap-orphan-media, csam intake), and add:

```ts
/** The JS twin of MEDIA_KEY_SQL_PATTERN — same shape, for parsing input and markdown in the Worker. */
const MEDIA_KEY_JS = /media\/post\/([0-9a-f]{64})\.webp/;
const MEDIA_KEY_JS_GLOBAL = /media\/post\/([0-9a-f]{64})\.webp/g;
const BARE_SHA256 = /^[0-9a-f]{64}$/;

/**
 * One line of a moderator's paste (a CSAM tool email's matched path, a CDN URL,
 * or a bare digest) → the sha256, or null. The domain is NOT checked: the path
 * shape is the identity (spec §3.2).
 */
export function sha256FromMatchInput(line: string): string | null {
  const t = line.trim().toLowerCase();
  if (BARE_SHA256.test(t)) return t;
  return MEDIA_KEY_JS.exec(t)?.[1] ?? null;
}

/** Every sha256 a markdown body embeds, deduplicated, first-appearance order. */
export function sha256sInMarkdown(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(MEDIA_KEY_JS_GLOBAL)].map((m) => m[1]!))];
}
```

In `reachability.ts`, delete `MEDIA_KEY_REGEX_SQL` and import `MEDIA_KEY_SQL_PATTERN`, using it at the one interpolation site. In `reap-orphan-media.ts`, replace **every** inline `'media/post/([0-9a-f]{64})\\.webp'` literal (there are two after #126: `posts` and `moderation_snapshots`) with `'${MEDIA_KEY_SQL_PATTERN}'` inside the template literal.

- [ ] **Step 4:** run the new test, plus `reap-orphan-media.test.ts` and `media-restricted-route.test.ts` (reachability's consumer) → PASS. `pnpm typecheck` clean.
- [ ] **Step 5:** commit `refactor(media): one media-key pattern, plus parsing helpers for CSAM intake (Part of #114)`.

---

### Task 2: `applyAccountActionInTx`

**Files:** modify `apps/api/src/moderation/account-actions.ts`; test `apps/api/test/account-actions.test.ts` (append).

**Produces:** `applyAccountActionInTx(c: Client, input: AccountActionInput): Promise<AccountActionOutcome>`. It's transaction-neutral and the caller owns the transaction. `applyAccountAction` keeps its signature and behaviour.

- [ ] **Step 1: Failing test** (append to the pool test file):

```ts
describe("the suspensionHours guard survives the split", () => {
  // Proves the named error and no writes. It does NOT isolate the wrapper's own
  // pre-BEGIN copy of the guard (the InTx copy would produce the same result);
  // that copy is kept for unchanged behaviour, not because this test pins it.
  it("applyAccountAction: suspend without hours throws the named error and writes nothing", async () => {
    const u = await mkUser();
    await expect(apply({ ...base, userId: u, kind: "suspend", reason: "x" })).rejects.toThrow(/suspend requires suspensionHours/);
    expect(await actionsFor(u)).toEqual([]);
  });
  it("applyAccountActionInTx: the same named error, not a raw Postgres parameter error", async () => {
    const u = await mkUser();
    await ctxRun(async (c) => {
      await c.query("BEGIN");
      await expect(applyAccountActionInTx(c, { ...base, userId: u, kind: "suspend", reason: "x" })).rejects.toThrow(
        /suspend requires suspensionHours/,
      );
      await c.query("ROLLBACK");
    });
  });
});

describe("applyAccountActionInTx — transaction-neutral (spec §3.3)", () => {
  it("leaves the caller's transaction open: a caller ROLLBACK undoes the bar and the log row", async () => {
    const u = await mkUser();
    await ctxRun(async (c) => {
      await c.query("BEGIN");
      const out = await applyAccountActionInTx(c, { ...base, userId: u, kind: "terminate", reason: "x" });
      expect(out.kind).toBe("applied");
      // An inner ROLLBACK on the applied path would also leave the DB clean, so
      // prove the transaction is still OPEN (SAVEPOINT errors outside one).
      await expect(c.query("SAVEPOINT still_open_applied")).resolves.toBeDefined();
      await c.query("ROLLBACK");
    });
    expect(await status(u)).toEqual({ suspended_until: null, disabled_at: null, disabled_reason: null });
    expect(await actionsFor(u)).toEqual([]);
  });

  it("an early-out (not_found) does not end the caller's transaction", async () => {
    await ctxRun(async (c) => {
      await c.query("BEGIN");
      expect((await applyAccountActionInTx(c, { ...base, userId: crypto.randomUUID(), kind: "warn", reason: "x" })).kind).toBe("not_found");
      // SAVEPOINT errors outside a transaction block, so this succeeds ONLY if
      // the early-out left the caller's transaction open (no inner ROLLBACK).
      await expect(c.query("SAVEPOINT still_open")).resolves.toBeDefined();
      await c.query("ROLLBACK");
    });
  });
});
```

- [ ] **Step 2:** run → FAIL (`applyAccountActionInTx` is not exported).
- [ ] **Step 3: Implement.** Make the same three-change split plan B made for `applyDecisionInTx`:
  1. Move everything after `await c.query(BEGIN_BOUNDED_TX);` and before `await c.query("COMMIT");` into `export async function applyAccountActionInTx(c, input)`, keeping the `FOR UPDATE` lock. ⚠️ **The `suspend requires suspensionHours` guard today sits BEFORE `BEGIN_BOUNDED_TX`**, outside that range. Keep it there in the wrapper, so `applyAccountAction` still throws before opening a transaction, which is unchanged behaviour. **Also** copy it as the first statement of `applyAccountActionInTx`, so a direct caller gets the same named error instead of a raw Postgres parameter error. (The plan-A suite never omits `suspensionHours`, so without the new test below this regression would be invisible.)
  2. Its two early-outs become `return { kind: "not_found" };` and `return { kind: "already_disabled" };` **with no ROLLBACK**.
  3. Delete the COMMIT; no try/catch.

`applyAccountAction` becomes:

```ts
export async function applyAccountAction(c: Client, input: AccountActionInput): Promise<AccountActionOutcome> {
  // Unchanged from plan A: refuse BEFORE opening a transaction.
  if (input.kind === "suspend" && input.suspensionHours === undefined) {
    throw new Error("applyAccountAction: suspend requires suspensionHours");
  }
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const out = await applyAccountActionInTx(c, input);
    if (out.kind !== "applied") {
      await rollbackQuietly(c); // nothing was written; a failed ROLLBACK must not change the answer
      return out;
    }
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await rollbackQuietly(c);
    throw err;
  }
}
```

- [ ] **Step 4:** run the whole `account-actions.test.ts` (every existing `applyAccountAction` test must still pass, unchanged) plus `admin-accounts-route.test.ts` → PASS.
- [ ] **Step 5:** commit `refactor(moderation): split applyAccountActionInTx for the CSAM confirm transaction (Part of #114)`.

---

### Task 2a: Close the two preservation gaps (spec §3.7, §5)

**Files:** modify `apps/api/src/media/reap-orphan-media.ts`, `apps/api/src/routes/media.ts`; test `apps/api/test/reap-orphan-media.test.ts` and `apps/api/test/media.test.ts` (append).

Both gaps exist on main today; R1 (the uploader stays active) makes them live.

- [ ] **Step 1: Failing tests.**
  - **Reaper:** seed a `media` row older than 24 h that no post or snapshot references, and a `media_legal_holds` row on its `r2_key`. After `reapOrphanMedia`, the `media` row still exists. **Control:** an identical unheld row in the same run IS reaped (so the test can see a reap at all).
  - **Upload:** put a `media_legal_holds` row on the key the fixture image produces (`media/post/<sha256 of the transformed output>.webp`; compute it by uploading once in a setup step, then deleting the row and object), then upload the same image. Expect `415 UNSUPPORTED_MEDIA_TYPE` with the route's usual body, `env.MEDIA.head(key)` null, and no new `media` row. **Control:** the same upload with no hold returns 201 (`media.ts:231`) and writes both. The `csam_upload_attempts` assertion is added in Task 6 once the table exists.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
  - `reap-orphan-media.ts`: in the `orphans` CTE (`:81-86` at `9a76b6f`), add `AND NOT EXISTS (SELECT 1 FROM media_legal_holds h WHERE h.r2_key = m.r2_key)`. Comment: a held key is evidence (spec §5), and its `media` rows say who uploaded it.
  - `media.ts`: between step 8 (hash) and step 9 (`env.MEDIA.put`, `:195`), `if (await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => isKeyLegallyHeld(c, key))) return unsupportedMediaType();`. Comment why the body is the shared one (it must not reveal that a key is held). Task 6 extends this branch to log a `csam` attempt.
- [ ] **Step 4:** run both files, plus `media-restricted-route.test.ts` → PASS. Commit `fix(media): a legally held key is never re-uploaded to the public bucket or reaped (Part of #114)`.

---

### Task 3: Schema

**Files:** create `apps/api/migrations/0026_csam.sql`; modify `apps/api/src/moderation/actions.ts` (the `ModerationActionKind` union) and `apps/api/test/migrations.db.test.ts`; test `apps/api/test/csam-schema.db.test.ts`.

**Ruling recorded here (spec §5 vs §4.3):** a deletion-window resubmission (§4.3) sends **new** XML for the same `ncmec_reports` row. Preserving "the exact bytes sent" therefore needs **one append-only row per submission**: `ncmec_submissions`.

- [ ] **Step 1: Failing schema test** (Node project, the `test/reports-schema.db.test.ts` harness). Cases, each written out in full:
  - `moderation_actions` accepts `'csam_hold'`, `'csam_review'` and `'csam_clear_release'`, **still accepts every kind 0022 allows** (`account_hold`, `account_hold_release` included), and still rejects `'nonsense'`.
  - `csam_cases`: `source`/`kind` accept exactly the spec §3.1 pairs (`cloudflare_match`+`known_hash`, `self_scan`+`known_hash`, `self_scan`+`classifier`, `moderator`+`moderator_sighting`) and reject a mismatched pair (`cloudflare_match`+`classifier`); `priority` accepts only `urgent|high|decided`; `review_outcome` accepts only `confirmed|false_positive`; `csam_cases_review_consistent` requires `reviewed_at`/`reviewed_by` exactly when `review_outcome` is set; `csam_cases_clear_two_hands` refuses a `false_positive` on a `known_hash` case whose `clear_requested_by` equals `reviewed_by` case-insensitively.
  - `csam_case_files` is UNIQUE on `(r2_key, kind)` (`csam_case_files_r2_key_kind_key`): the same key twice with the same kind fails, with a different kind succeeds.
  - `ncmec_reports.status` accepts exactly `awaiting_credentials|pending|submitted|finished|failed|retract_pending|withdrawn`.
  - `ncmec_submissions`: UPDATE refused, DELETE of a row younger than 1 year refused, a control DELETE at 366 days allowed, TRUNCATE refused. Same guard shape as `0021`'s `moderation_snapshots`.
  - `media_legal_hold_releases` and `csam_upload_attempts`: UPDATE and TRUNCATE refused (append-only).
  - none of these tables has an FK to `users`, `posts` or `media` (evidence outlives its subject; the same reasoning as 0013). Control: `reports` does.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Migration.**

```sql
-- Up Migration
--
-- #114 — the CSAM → NCMEC pipeline (spec 2026-10-01-csam-reporting-pipeline-design.md, revision 1).
-- ⚠️ BARE uuids for users/posts/media everywhere: this is evidence and must
-- outlive its subjects, the same reasoning as moderation_actions (0013).
--
-- ⚠️ The CHECK list is 0022's (the latest rebuild, 0022_account_legal_holds.sql:70)
-- plus this migration's three kinds. Re-read the latest rebuild before writing it.
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide',
    'account_hold','account_hold_release',
    'csam_hold','csam_review','csam_clear_release'
  ));

CREATE TABLE csam_cases (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  source             text NOT NULL CHECK (source IN ('cloudflare_match', 'self_scan', 'moderator')),
  kind               text NOT NULL CHECK (kind IN ('known_hash', 'classifier', 'moderator_sighting')),
  priority           text NOT NULL CHECK (priority IN ('urgent', 'high', 'decided')),
  hold_action_id     uuid NOT NULL,        -- bare: the csam_hold moderation_actions row
  opened_by          text NOT NULL,        -- Access identity, or 'system:self-scan'
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Escalation (spec §6.2): the durable alarm queue. NULL once decided.
  alarm_next_at      timestamptz,
  alarms_sent        int NOT NULL DEFAULT 0,
  last_alarm_at      timestamptz,
  -- Review. A known_hash CLEAR needs two hands (spec §7.2, a proposal).
  clear_requested_by text,
  clear_requested_at timestamptz,
  review_outcome     text CHECK (review_outcome IN ('confirmed', 'false_positive')),
  reviewed_by        text,
  reviewed_at        timestamptz,
  review_statement   text,
  ncmec_followup_at  timestamptz,          -- runbook: when NCMEC was told of a clear (spec §7.2)
  ncmec_followup_by  text,
  CONSTRAINT csam_cases_source_kind CHECK (
    (source = 'cloudflare_match' AND kind = 'known_hash')
    OR (source = 'self_scan' AND kind IN ('known_hash', 'classifier'))
    OR (source = 'moderator' AND kind = 'moderator_sighting')),
  CONSTRAINT csam_cases_review_consistent CHECK (
    (review_outcome IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_outcome IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CONSTRAINT csam_cases_clear_two_hands CHECK (
    review_outcome IS DISTINCT FROM 'false_positive' OR kind <> 'known_hash'
    OR (clear_requested_by IS NOT NULL
        AND lower(btrim(clear_requested_by)) <> lower(btrim(reviewed_by))))
);
CREATE INDEX csam_cases_undecided_idx ON csam_cases (alarm_next_at) WHERE review_outcome IS NULL;

-- ⚠️ UNIQUE (r2_key, kind): suppression (spec §3.6; AC-C10). A key has at most
-- one case per detection kind; a stronger kind may open a second.
CREATE TABLE csam_case_files (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id       uuid NOT NULL REFERENCES csam_cases(id),
  r2_key        text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('known_hash', 'classifier', 'moderator_sighting')),
  sha256        text NOT NULL,
  revealed_at   timestamptz,
  revealed_by   text,
  evidence_key  text,                      -- set by a CLEAR (spec §7.2)
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT csam_case_files_r2_key_kind_key UNIQUE (r2_key, kind)
);

-- The posts this case hid, so a CLEAR restores exactly them.
CREATE TABLE csam_case_targets (
  case_id  uuid NOT NULL REFERENCES csam_cases(id),
  post_id  uuid NOT NULL,                  -- bare
  PRIMARY KEY (case_id, post_id)
);

-- A re-upload of a csam-held file (spec §3.7). Append-only.
CREATE TABLE csam_upload_attempts (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id      uuid NOT NULL REFERENCES csam_cases(id),
  user_id      uuid NOT NULL,              -- bare
  r2_key       text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ncmec_reports (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id              uuid NOT NULL REFERENCES csam_cases(id),
  subject_user_id      uuid NOT NULL,      -- bare: the uploader this report is about
  queued_by            text NOT NULL CHECK (queued_by IN ('match', 'confirm')),
  status               text NOT NULL CHECK (status IN ('awaiting_credentials','pending','submitted','finished','failed','retract_pending','withdrawn')),
  ncmec_report_id      text,
  opened_at            timestamptz,        -- when the CURRENT ncmec_report_id was opened (submit)
  last_modified_at     timestamptz,        -- last successful NCMEC call on the current report
  finished_at          timestamptz,
  withdrawn_at         timestamptz,
  abandoned_report_ids text[] NOT NULL DEFAULT '{}',
  attempts             int NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  last_error           text,
  last_response_code   int,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ncmec_reports_one_per_uploader UNIQUE (case_id, subject_user_id)
);
CREATE INDEX ncmec_reports_due_idx ON ncmec_reports (next_attempt_at)
  WHERE status IN ('pending', 'submitted', 'awaiting_credentials', 'retract_pending');

CREATE TABLE ncmec_report_files (
  report_id     uuid NOT NULL REFERENCES ncmec_reports(id),
  case_file_id  uuid NOT NULL REFERENCES csam_case_files(id),
  viewed_by_esp boolean NOT NULL,          -- fileViewedByEsp, fixed when the report is queued (spec §3.1)
  ncmec_file_id text,                      -- cleared when the report is resubmitted
  fileinfo_sent boolean NOT NULL DEFAULT false,
  PRIMARY KEY (report_id, case_file_id)
);

-- The exact XML sent on every submit — §2258A(h)(1) "the contents provided in
-- the report", kept >= 1 year. One row per SEND (resubmission sends again).
CREATE TABLE ncmec_submissions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  report_id       uuid NOT NULL REFERENCES ncmec_reports(id),
  ncmec_report_id text,                    -- NULL if the submit itself failed
  request_xml     text NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now()
);
-- Same guard as 0021's moderation_snapshots: no UPDATE, no TRUNCATE, no DELETE
-- inside the first year. Mirror its function/trigger pair exactly, renamed
-- ncmec_submissions_guard / ncmec_submissions_no_update_or_early_delete /
-- ncmec_submissions_no_truncate, using sent_at as the age column.
-- ⚠️ ONE EXCEPTION: the backfill of ncmec_report_id after a successful submit
-- (Task 7). Allow an UPDATE that changes ONLY ncmec_report_id from NULL to a
-- value; refuse every other UPDATE.

-- A released CSAM-clear media hold (spec §7.2): the media_legal_holds row is
-- MOVED here, so every existing reader of media_legal_holds stays correct.
CREATE TABLE media_legal_hold_releases (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  r2_key               text NOT NULL,
  category             text NOT NULL,
  imposed_by           text NOT NULL,
  imposed_at           timestamptz NOT NULL,
  moderation_action_id uuid,              -- the hold's own action
  case_id              uuid NOT NULL REFERENCES csam_cases(id),
  release_action_id    uuid NOT NULL,     -- the csam_clear_release action
  released_by          text NOT NULL,     -- the approving hand
  requested_by         text NOT NULL,     -- the requesting hand
  released_at          timestamptz NOT NULL DEFAULT now()
);
-- Append-only: no UPDATE, no TRUNCATE (a guard trigger pair like the one above, without the age clause).

-- Down Migration
DROP TABLE IF EXISTS media_legal_hold_releases;
DROP FUNCTION IF EXISTS media_legal_hold_releases_guard();
DROP TABLE IF EXISTS ncmec_submissions;
DROP FUNCTION IF EXISTS ncmec_submissions_guard();
DROP TABLE IF EXISTS ncmec_report_files;
DROP TABLE IF EXISTS ncmec_reports;
DROP TABLE IF EXISTS csam_upload_attempts;
DROP FUNCTION IF EXISTS csam_upload_attempts_guard();
DROP TABLE IF EXISTS csam_case_targets;
DROP TABLE IF EXISTS csam_case_files;
DROP TABLE IF EXISTS csam_cases;
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide',
    'account_hold','account_hold_release'
  ));
```

⚠️ The Down's CHECK list must equal 0022's Up list exactly. Diff the two before committing.

Add `| "csam_hold" | "csam_review" | "csam_clear_release"` to `ModerationActionKind` (`actions.ts`) with a one-line comment each. Add up/down `tableExists` assertions for the eight tables to `migrations.db.test.ts`.
- [ ] **Step 4:** run → PASS; commit `feat(db): CSAM cases, NCMEC reports and preserved submissions (Part of #114)`.

---

### Task 4: The XML layer, and the pinned parser

**Files:** modify `apps/api/package.json`; create `apps/api/src/csam/ncmec-xml.ts`, `apps/api/test/ncmec-xml.node.test.ts`, `apps/api/test/fast-xml-parser-characterisation.node.test.ts`.

**Produces:** `buildReportXml(input: ReportXmlInput): string`, `buildFileDetailsXml(input: FileDetailsInput): string`, `parseNcmecResponse(body: Uint8Array): NcmecResponse` (throws `NcmecResponseTooLarge` above `NCMEC_RESPONSE_MAX_BYTES`), `readCapped(res: Response, max: number): Promise<Uint8Array>`.

- [ ] **Step 1: The dependency.** Add `"fast-xml-parser": "<exact version apps/web pins>"` to `apps/api/package.json` dependencies, **without `^`**. It's `5.11.2` at `9a76b6f` (`apps/web/package.json:25`); read `apps/web/package.json` and use its value. Run `pnpm install`.
- [ ] **Step 2: The characterisation test (AC-C12).** Create `fast-xml-parser-characterisation.node.test.ts`. Read `docs/superpowers/specs/2026-09-08-xml-parser-decision.md` §3–§4 and encode **each** probe it ran: the external-entity file reference (must throw), nested entity expansion (must not expand, returned literally), deep nesting at 1 000 (must throw "Maximum nested tags exceeded"), a benign document (parses), and an NCMEC-shaped response (parses to the expected object). Each runs against the installed version, configured exactly as `ncmec-xml.ts` will configure it (`processEntities: false`). Its header states: **if any of these fails after a version bump, that is a STOP**, not a test to adjust (spec §4.3).
- [ ] **Step 3: Failing XML-layer test** (`ncmec-xml.node.test.ts`). Cases, each written out in full:
  - `buildReportXml` escapes `& < > " '` in every interpolated field (a screen name like `a<b&"c'`), and the output starts with `<?xml version="1.0" encoding="UTF-8"?>`.
  - it emits the incident type, the incident time (ISO-8601), the reporting person's name, email, phone and address, and the reported person's `espIdentifier`, `screenName`, `profileUrl` and `email`. **No IP element appears** (we hold none; spec §4.5). Fixtures use fake values only (`Test Reporter`, `reporter@example.test`, `+1 555 0100`, `1 Example Way`).
  - `buildFileDetailsXml` emits `reportId`, `fileId`, `fileViewedByEsp` (`true`/`false`; a match-time report's files are `false`, spec §4.5), `publiclyAvailable` (`true`) and `originalFileHash` with `hashType="SHA256"`.
  - `parseNcmecResponse` on `<reportResponse><responseCode>0</responseCode><reportId>4711</reportId></reportResponse>` gives `{ responseCode: 0, reportId: "4711" }`; a `<fileId>` yields `fileId`; `responseDescription` is carried.
  - ⚠️ a body of `NCMEC_RESPONSE_MAX_BYTES + 1` bytes throws `NcmecResponseTooLarge` **and the parser is never called**. Spy on the parser module, or assert the throw happens with a body that is not valid XML at all. **Mutation (AC-C5):** remove the cap check, and the oversized-body test must FAIL. Report the result.
- [ ] **Step 4: Implement** `apps/api/src/csam/ncmec-xml.ts`:

```ts
/**
 * NCMEC CyberTipline ISP Web Services — XML in, XML out (spec §4).
 *
 * ⚠️ BUILT, NEVER PARSED, ON THE WAY OUT: request XML is assembled with an
 * escaper (the same discipline as apps/web/src/lib/xml.ts), so no parser ever
 * sees attacker-influenced text on our side.
 * ⚠️ ON THE WAY IN, THE BYTE CAP IS THE CONTROL (2026-09-08 decision §5), and
 * it runs BEFORE the parser. `processEntities: false` is kept for parity; the
 * decision measured it as inert for the probed vectors.
 * ⚠️ ELEMENT NAMES follow the research notes and are checked against the live
 * XSD (GET /xsd) in Task 11 — this file is where a correction lands.
 */
import { XMLParser } from "fast-xml-parser";

export const NCMEC_RESPONSE_MAX_BYTES = 64 * 1024;

export class NcmecResponseTooLarge extends Error {
  constructor() {
    super(`NCMEC response exceeded ${NCMEC_RESPONSE_MAX_BYTES} bytes`);
  }
}

export function escapeXml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export interface ReportXmlInput {
  readonly incidentDateTime: Date;
  /** From the NCMEC_REPORTER_* secrets (Task 5's ncmecConfig). Never a literal in code. */
  readonly reporter: { readonly firstName: string; readonly lastName: string; readonly email: string; readonly phone: string; readonly address: string };
  readonly reported: { readonly espIdentifier: string; readonly screenName: string; readonly profileUrl: string; readonly email: string };
  readonly webPageUrls: readonly string[];
}

export function buildReportXml(i: ReportXmlInput): string {
  const e = escapeXml;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<report>` +
    `<incidentSummary>` +
    `<incidentType>Child Pornography (possession, manufacture, and distribution)</incidentType>` +
    `<incidentDateTime>${e(i.incidentDateTime.toISOString())}</incidentDateTime>` +
    `</incidentSummary>` +
    `<internetDetails>` +
    i.webPageUrls.map((u) => `<webPageIncident><url>${e(u)}</url></webPageIncident>`).join("") +
    `</internetDetails>` +
    `<reporter><reportingPerson>` +
    `<firstName>${e(i.reporter.firstName)}</firstName><lastName>${e(i.reporter.lastName)}</lastName>` +
    `<email>${e(i.reporter.email)}</email>` +
    `<phone>${e(i.reporter.phone)}</phone>` +
    `<address>${e(i.reporter.address)}</address>` +
    `</reportingPerson></reporter>` +
    `<personOrUserReported>` +
    `<espIdentifier>${e(i.reported.espIdentifier)}</espIdentifier>` +
    `<screenName>${e(i.reported.screenName)}</screenName>` +
    `<profileUrl>${e(i.reported.profileUrl)}</profileUrl>` +
    `<email>${e(i.reported.email)}</email>` +
    `</personOrUserReported>` +
    `</report>`
  );
}

export interface FileDetailsInput {
  readonly reportId: string;
  readonly fileId: string;
  readonly viewedByEsp: boolean;
  readonly sha256: string;
}

export function buildFileDetailsXml(i: FileDetailsInput): string {
  const e = escapeXml;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<fileDetails>` +
    `<reportId>${e(i.reportId)}</reportId><fileId>${e(i.fileId)}</fileId>` +
    `<fileViewedByEsp>${i.viewedByEsp}</fileViewedByEsp>` +
    `<publiclyAvailable>true</publiclyAvailable>` +
    `<originalFileHash hashType="SHA256">${e(i.sha256)}</originalFileHash>` +
    `</fileDetails>`
  );
}

export interface NcmecResponse {
  readonly responseCode: number;
  readonly responseDescription?: string;
  readonly reportId?: string;
  readonly fileId?: string;
}

/** Read at most `max` bytes; throw the moment the body would exceed it. */
export async function readCapped(res: Response, max: number = NCMEC_RESPONSE_MAX_BYTES): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new NcmecResponseTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}

const parser = new XMLParser({ processEntities: false, ignoreAttributes: true, parseTagValue: false });

export function parseNcmecResponse(body: Uint8Array): NcmecResponse {
  if (body.byteLength > NCMEC_RESPONSE_MAX_BYTES) throw new NcmecResponseTooLarge();
  const doc = parser.parse(new TextDecoder().decode(body)) as Record<string, Record<string, unknown> | undefined>;
  const r = doc["reportResponse"] ?? doc["reportDoneResponse"] ?? {};
  const str = (k: string) => (r[k] === undefined || r[k] === null ? undefined : String(r[k]));
  const code = Number(str("responseCode"));
  return {
    responseCode: Number.isFinite(code) ? code : -1,
    responseDescription: str("responseDescription"),
    reportId: str("reportId"),
    fileId: str("fileId"),
  };
}
```

- [ ] **Step 5:** run both tests → PASS; run the cap mutation → FAIL → restore. `pnpm typecheck`. Commit `feat(csam): NCMEC XML layer with a byte cap before parsing; pinned parser characterised (Part of #114)`.

---

### Task 5: The NCMEC client

**Files:** create `apps/api/src/csam/ncmec-client.ts`, `apps/api/test/ncmec-client.test.ts` (pool, with `fetch` stubbed).

**Produces:**
```ts
export interface NcmecConfig {
  readonly baseUrl: string; readonly username: string; readonly password: string;
  readonly reporter: ReportXmlInput["reporter"]; // from NCMEC_REPORTER_NAME/EMAIL/PHONE/ADDRESS
}
export function ncmecConfig(env: Env): NcmecConfig | null; // null when any of the seven is missing or blank
export type NcmecCall =
  | { readonly kind: "ok"; readonly response: NcmecResponse }
  | { readonly kind: "ncmec_error"; readonly response: NcmecResponse }      // a non-zero responseCode
  | { readonly kind: "transport_error"; readonly status: number | null; readonly error: string }; // network, 5xx, cap, unparseable
export function submit(cfg: NcmecConfig, xml: string): Promise<NcmecCall>;
export function upload(cfg: NcmecConfig, reportId: string, fileName: string, body: ReadableStream | ArrayBuffer): Promise<NcmecCall>;
export function fileinfo(cfg: NcmecConfig, xml: string): Promise<NcmecCall>;
export function finish(cfg: NcmecConfig, reportId: string): Promise<NcmecCall>;
export function retract(cfg: NcmecConfig, reportId: string): Promise<NcmecCall>; // only before finish; 5102 after
```

- [ ] **Step 1: Failing test.** Stub `fetch` (the `vi.stubGlobal` idiom from `test/moderation-notify.test.ts`), capturing method, URL, headers and body. Cases, each written out in full:
  - `ncmecConfig` → null when any of `NCMEC_BASE_URL`, `NCMEC_USERNAME`, `NCMEC_PASSWORD`, `NCMEC_REPORTER_NAME`, `NCMEC_REPORTER_EMAIL`, `NCMEC_REPORTER_PHONE`, `NCMEC_REPORTER_ADDRESS` is missing or blank (one case per variable); otherwise the trimmed base URL with no trailing slash, and the reporter. `NCMEC_REPORTER_NAME` is split at its **first** whitespace into `firstName`/`lastName` (a one-word name gives an empty `lastName`; Task 11's XSD check may change this). Add the eight new names (the seven NCMEC ones and `CSAM_ALARM_EMAIL`) to `worker-configuration.d.ts` the way `RESERVED_EMAIL_KEY` is declared there (`:46-48`).
  - `submit` POSTs `<base>/submit` with `content-type: text/xml; charset=utf-8` and `Authorization: Basic base64(user:pass)`; a `responseCode 0` body → `ok` with `reportId`.
  - `upload` POSTs `<base>/upload` as `multipart/form-data` with fields `id=<reportId>` and `file=<blob, fileName>` → `ok` with `fileId`.
  - `fileinfo` POSTs `<base>/fileinfo` with the XML. `finish` and `retract` POST `<base>/finish` and `<base>/retract` with form field `id=<reportId>`; `retract` answered `5102` → `ncmec_error` carrying 5102.
  - `responseCode 4100` → `ncmec_error` (carrying 4100). An HTTP 503 → `transport_error` with status 503. A thrown `fetch` → `transport_error` with status null. An oversized body → `transport_error` whose error names the cap.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** with one private `call(cfg, path, init)` that adds the Basic header and makes the request in a try/catch. A non-2xx status is a `transport_error` (the body is not parsed). Otherwise `readCapped` then `parseNcmecResponse`; `responseCode === 0` → `ok`, otherwise `ncmec_error`; any thrown error, `NcmecResponseTooLarge` included, → `transport_error`. Use `btoa(`${username}:${password}`)` for the header. Build multipart bodies with `FormData`, so the runtime sets the boundary; never set `content-type` by hand for those.
- [ ] **Step 4:** run → PASS; commit `feat(csam): NCMEC ISP Web Services client (Part of #114)`.

---

### Task 6: Intake (quarantine)

**Files:** create `apps/api/src/csam/config.ts`, `apps/api/src/csam/intake.ts`; modify `apps/api/src/routes/media.ts` (Task 2a's held-key branch logs a csam attempt); test `apps/api/test/csam-intake.test.ts` (pool).

**Produces:**
```ts
// config.ts
export const CSAM_BAR_UNREVIEWED_MATCH = false; // R1, quoted verbatim above it
export const CSAM_REPORT_AT_MATCH = true;       // "Option B.", quoted verbatim above it; known_hash only
export const CSAM_INTAKE_LOCK_ID = 114_000_001; // pg_advisory_xact_lock key
export const CSAM_SELF_SCAN_ACTOR = "system:self-scan";
// intake.ts
export type DetectionKind = "known_hash" | "classifier" | "moderator_sighting";
export type IntakeInput =
  | { readonly source: "cloudflare_match"; readonly kind: "known_hash"; readonly sha256s: readonly string[]; readonly actorAdmin: string }
  | { readonly source: "self_scan"; readonly kind: "known_hash" | "classifier"; readonly sha256s: readonly string[]; readonly actorAdmin: string }
  | { readonly source: "moderator"; readonly kind: "moderator_sighting"; readonly subject: "post"; readonly subjectId: string; readonly actorAdmin: string };
export type IntakeResult =
  | { readonly kind: "opened"; readonly caseId: string; readonly reports: number; readonly hiddenPosts: number; readonly heldAccounts: number }
  | { readonly kind: "already_cased"; readonly cases: readonly { readonly caseId: string; readonly outcome: "undecided" | "confirmed" | "false_positive" }[] }
  | { readonly kind: "nothing_to_do"; readonly reason: "no_media_rows" | "post_has_no_media" | "post_not_found" };
export function queuesReportAtMatch(kind: DetectionKind, reportAtMatch: boolean): boolean; // pure
export function isSuppressed(kind: DetectionKind, existing: readonly { readonly kind: DetectionKind; readonly outcome: "undecided" | "confirmed" | "false_positive" }[]): boolean; // pure, spec §3.6
export function runIntake(env: Env, ctx: ExecutionContext, input: IntakeInput, hooks?: { readonly beforeCommit?: (c: Client) => Promise<void> }): Promise<IntakeResult>;
```

**The two constants (spec §3.4, AC-C6).** `config.ts` carries, above each constant, CireSnave's ruling **verbatim** with "relayed by the PM, 2026-10-04": R1's full text above `CSAM_BAR_UNREVIEWED_MATCH = false`, and `"Option B."` plus the option as put to him above `CSAM_REPORT_AT_MATCH = true`. Tests pin **both** branches of each through the pure functions, with the flag passed explicitly, so a future change of either constant needs no test change. There is no placeholder anywhere: contact values are secrets (Task 5), not constants.

**Comment-media note:** comments carry no media today (only `posts.markdown_source` is scanned, `reachability.ts:55`). Intake resolves embedding **posts** only, and (c) accepts `subject: "post"` only. Say so in `intake.ts`'s header.

- [ ] **Step 1: Failing test.** Fixtures: seed `media` rows (owner, `r2_key`, sha256), put objects in `env.MEDIA`, and seed posts whose markdown embeds them, reusing `reap-orphan-media.test.ts`'s `seedMedia`/`insertPost` idiom. Stub `env.WEB` for the cache purge as `admin-decision-route.test.ts` does, and stub Postmark to capture messages. Cases, each written out in full:
  - **(a) known-hash match, single uploader, embedded once:** `opened`. Then:
    - the post 404s through the **public** read route, `env.MEDIA.get(key)` is null and `env.MEDIA_RESTRICTED.get(key)` is not (AC-C1, AC-C9); `GET /media/restricted/:sha256` returns 404 to the author's session and to an admin without a grant, and 200 to an admin with an approved two-person grant (AC-C14);
    - the key is in `media_legal_holds` with `category = 'csam'` and `moderation_action_id` = the case's `hold_action_id`; a `moderation_snapshots` row exists for the post; the post's decision row is `content_keep_hidden`;
    - ⚠️ **AC-C14, the uploader is NOT barred:** `disabled_at`, `disabled_reason` and `suspended_until` equal their values before intake, the uploader's epoch did not move, and a login as the uploader succeeds and a new post by them is accepted;
    - the uploader has an active `csam` row in `account_legal_holds` referencing `hold_action_id` (spec §3.3 step 7a);
    - the case is `kind = 'known_hash'`, `priority = 'urgent'`, `alarm_next_at <= now()`;
    - with `CSAM_REPORT_AT_MATCH` as set (`true`): one `ncmec_reports` row, `queued_by = 'match'`, `pending` or `awaiting_credentials` as the env implies, and one `ncmec_report_files` row with `viewed_by_esp = false`;
    - exactly one alarm email went to the fake `CSAM_ALARM_EMAIL`, and none to anyone else (AC-C7).
  - **A classifier flag** (`self_scan`, `classifier`): the same quarantine and holds, `priority = 'high'`, and **zero** `ncmec_reports` rows. Also call `queuesReportAtMatch("classifier", true)` and `("classifier", false)` → both false (AC-C14).
  - **Both branches of `CSAM_REPORT_AT_MATCH`:** `queuesReportAtMatch("known_hash", true)` → true; `("known_hash", false)` → false; `("moderator_sighting", x)` → false (a sighting's report is queued by its CONFIRM, Task 9). An intake with the constant **as set** matches the `true` branch.
  - **R1 as set:** a test asserts `CSAM_BAR_UNREVIEWED_MATCH === false` and that `intake.ts` contains no call to `applyAccountActionInTx` (read the source, as Task 1's pin does), so a bar cannot creep into intake.
  - ⚠️ **RF2 / AC-C9, an orphan upload** (no post embeds the key): the object still leaves `MEDIA` for `MEDIA_RESTRICTED`, and the hold exists. **Mutation:** drop the orphan-move call → FAIL.
  - ⚠️ **RF3 / AC-C11, a multi-uploader key plus a second key only one of them uploaded:** two reports. Uploader A's report carries both files; B's report carries only the shared one. Both A and B have `csam` account holds; neither is barred.
  - ⚠️ **RF1 / AC-C10, suppression:** run the same intake twice. The second returns `already_cased` naming the first case as `undecided`; the counts of `csam_cases`, `ncmec_reports`, holds, `moderation_actions` and alarm emails are unchanged. **Mutation:** remove step 2's filter → FAIL. Then the pure `isSuppressed` table: known_hash vs an undecided classifier case → true; known_hash vs a cleared classifier case → **false** (opens a case); classifier vs a cleared known_hash case → true; any kind vs a confirmed case → true.
  - A **mixed batch** (one suppressed key and one new key with a different uploader): only the new key is cased, and only the new uploader gets a hold.
  - **(c) moderator sighting:** runs intake **and** Task 9's CONFIRM in one transaction: the uploader is terminated, the report is queued with `queued_by = 'confirm'` and `viewed_by_esp = true`, `review_outcome = 'confirmed'`, `reviewed_by` = the moderator. (Write this case now, `it.todo` until Task 9 lands, then make it real there.)
  - **Re-upload (AC-C17):** after a known-hash intake, the uploader re-uploads the identical image: 415, nothing in `MEDIA`, and one `csam_upload_attempts` row naming the case and the user.
  - **AC-C7:** after any intake, the stubbed Postmark captured **zero** messages to the uploader or any author.
  - **Atomicity:** `runIntake`'s optional 4th parameter `hooks.beforeCommit` (tests only; the header says so) throws. Afterwards nothing is left behind: no case, no hold, no hidden post, no report, no alarm email; the error propagates; and no post-commit step ran (the object is still in `MEDIA`).
  - **Unrecognised input:** the route test (Task 9) covers the line-by-line rejection. Here, an intake whose sha256s match no `media` row returns `nothing_to_do: no_media_rows`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement `config.ts`** as above.
- [ ] **Step 4: Implement `intake.ts`.** It follows spec §3.3 steps 0–9 (there is no step 7: R1 removed it), **including step 7a**, literally, in that order. The helpers it needs all exist on main or in earlier tasks: `sha256sInMarkdown`, `r2KeyForSha256`, `MEDIA_KEY_SQL_PATTERN`, `imposeLegalHold` (`legal-hold.ts:19`), `imposeAccountHoldInTx` (`account-holds.ts:98`), `applyDecisionInTx` (`decide.ts:90`), `recordModerationAction`, `afterContentDecision` (`after-content-decision.ts:29`), `enqueueAndAttemptMove` (`moves.ts:41`). Required SQL:
  - uploaders of keys: `SELECT DISTINCT owner_id, r2_key, sha256, min(created_at) OVER (PARTITION BY owner_id) AS first_upload FROM media WHERE r2_key = ANY($1::text[])`
  - embedding posts: a scan matching `regexp_matches(markdown_source, '${MEDIA_KEY_SQL_PATTERN}', 'g')` against the key set, index-free like the reaper.
  - existing cases for suppression: `SELECT f.case_id, f.r2_key, f.kind, COALESCE(c.review_outcome, 'undecided') AS outcome FROM csam_case_files f JOIN csam_cases c ON c.id = f.case_id WHERE f.r2_key = ANY($1::text[])`, then `isSuppressed` per key.
  - lock: `SELECT pg_advisory_xact_lock($1)` with `CSAM_INTAKE_LOCK_ID`, as the **first** statement after `BEGIN_BOUNDED_TX`.
  - step 6: lock the post (`SELECT … FOR UPDATE`), `INSERT INTO moderation_snapshots (post_id, author_id, title, body_markdown)` (the shape `posts.ts:515` uses), then `applyDecisionInTx(c, { subject: "post", subjectId, decision: "keep_hidden", reason: CSAM_QUARANTINE_REASON, actorAdmin })`. ⚠️ `CSAM_QUARANTINE_REASON` = `"Hidden pending a child-safety review."`: it is emailed verbatim to any DSA reporter whose confirmed notice this resolves (`decide.ts:144`, `after-content-decision.ts:59-64`), so it names no hash, case or person.
  - `csam_case_targets` gets one row per hidden post.
  - step 8: `ncmec_reports.status` is `ncmecConfig(env) === null ? 'awaiting_credentials' : 'pending'`, `queued_by = 'match'`, only when `queuesReportAtMatch(input.kind, CSAM_REPORT_AT_MATCH)`.
  - step 4: `priority` = `urgent` for `known_hash`, `high` for `classifier`; `alarm_next_at = now()`.

  Post-commit, exactly as spec §3.3 says: `afterContentDecision(env, ctx, { subject: "post", decision: "keep_hidden", reason: CSAM_QUARANTINE_REASON, result, legalHold: { category: "csam", imposedBy: actorAdmin } })` for each hidden post (⚠️ the `legalHold` object is **required**: without it the image stays public, and the AC-C9 mutation proves it); `enqueueAndAttemptMove(env, ctx, key, "to_restricted")` for each orphan key; then `sendCaseAlarm(env, ctx, caseId)` from Task 8 (best effort; until Task 8 lands, a stub that the tick will cover). No epoch bump: nobody is barred.

  In `media.ts`'s Task 2a branch: when the held key's hold is `csam`, insert a `csam_upload_attempts` row for the newest case holding that key (one statement; never fail the refusal if it errors, log it).

  The module header states: no notices (A3, R1), the R1 and "Option B" pointers, and the "one transaction, then post-commit" rationale.
- [ ] **Step 5:** run → PASS. Run the two mutations and record the results. Commit `feat(csam): intake — quarantine, preserve, hold, open a priority case, queue known-hash reports (Part of #114)`.

---

### Task 7: The drain

**Files:** create `apps/api/src/csam/drain.ts`; modify `apps/api/src/index.ts` (the `*/2` branch); test `apps/api/test/csam-drain.test.ts` (pool, NCMEC test double via a `fetch` stub that routes on URL path).

**Produces:** `runNcmecDrain(env, ctx, now?: Date): Promise<{ processed: number; finished: number }>`; constants in `config.ts`: `NCMEC_BACKOFF_MINUTES = [2, 4, 8, 16, 30]`, `NCMEC_DRAIN_BATCH = 10`.

- [ ] **Step 1: Failing test.** The double keeps per-test state (issued report ids, uploaded files, finished set) and can be scripted to fail a given call with a given code or HTTP status. Seed reports by running Task 6's `runIntake`, with `NCMEC_*` set in the test env (`env` spread with the three vars). Cases, each written out in full:
  - ⚠️ **AC-C2:** for a **known-hash** match, one `runNcmecDrain` takes the match-time `pending` report to `finished`, with no human call in between (the case is still undecided, and the uploader still active): submit → upload (per file) → fileinfo (per file) → finish, in that order. One `ncmec_submissions` row exists with the exact XML the double received (byte-equal); `ncmec_report_id`, `opened_at` and `finished_at` are set; each `ncmec_report_files` row has its `ncmec_file_id` and `fileinfo_sent = true`. The upload body equals the R2 object's bytes from `MEDIA_RESTRICTED`.
  - **Resume:** the double fails `fileinfo` once (HTTP 503). After drain 1, the status is still `submitted`, `attempts = 1`, `next_attempt_at` is about 2 min ahead, and the files are uploaded. Drain 2 (with `now` advanced past `next_attempt_at`) does **not** re-upload: zero upload calls, then fileinfo and finish → `finished`.
  - ⚠️ **RF4 / AC-C3 (deletion window):** a `submitted` report whose `opened_at` is 25 h ago and `last_modified_at` 2 h ago. The drain moves its id into `abandoned_report_ids`, clears the `ncmec_file_id`s, submits fresh (a **new** id, a **second** `ncmec_submissions` row) and finishes. The same happens for a double answering `5001` to `finish`. **Mutation:** remove the window check → FAIL.
  - `4100` on submit → `failed`, `last_response_code = 4100`, `last_error` carries the description, and **the next drain does not touch it**.
  - `2000` on submit → status unchanged (`pending`), `last_response_code = 2000`, and no further calls that tick for **any** report (credentials are shared).
  - `awaiting_credentials` rows are promoted to `pending` on a tick where `ncmecConfig(env)` is non-null, and left alone when it's null.
  - Not yet due (`next_attempt_at` in the future) → untouched.
  - **`fileViewedByEsp`:** a match-time report sends `false`; a report queued by a CONFIRM (seed its `ncmec_report_files.viewed_by_esp = true`) sends `true`.
  - ⚠️ **Retract (AC-C15):** a `retract_pending` report with an `ncmec_report_id` → one `POST /retract`, then `withdrawn` with `withdrawn_at`. A double answering `5102` → `finished`, and the case then lists "runbook follow-up due" (derived in Task 9: cleared, a `finished` report, `ncmec_followup_at IS NULL`). A `withdrawn` report is never touched again.
  - ⚠️ **A CLEAR that races a submit:** the double's `submit` handler flips the row to `retract_pending` (simulating a CLEAR committing mid-call) before it answers. The guarded write to `submitted` updates nothing; the drain stores the id on the row as `ncmec_report_id`, keeps the status `retract_pending`, and the same tick retracts it. Nothing reaches `finished`.
  - The `*/2` cron routes to `runNcmecDrain`: drive `scheduled` with that cron, as `reap-orphan-media.test.ts` drives its cron.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement `drain.ts`.**
  - Select due rows: `SELECT … FROM ncmec_reports WHERE status IN ('pending','submitted','retract_pending') AND next_attempt_at <= $now ORDER BY next_attempt_at LIMIT NCMEC_DRAIN_BATCH`, then process each **sequentially**.
  - ⚠️ **Every transition is a guarded write:** `UPDATE ncmec_reports SET … WHERE id = $1 AND status = $expected RETURNING id`. Zero rows means a CLEAR (Task 9) changed the status during the network call: re-read the row and continue from its new status (only `retract_pending` or `withdrawn` can appear that way). If a `submit` succeeded but the row is now `retract_pending`, record the returned id (`UPDATE … SET ncmec_report_id = $2 WHERE id = $1 AND ncmec_report_id IS NULL`) so the retract can name it; if it is `withdrawn` (the CLEAR happened before the id existed), set it to `retract_pending` with that id, because NCMEC now holds an open report.
  - `retract_pending` → `retract(cfg, ncmec_report_id)`: `ok` → `withdrawn`, `withdrawn_at = now`; `5102` → `finished` (it was finished first; the case then lists "runbook follow-up due"); any other failure backs off like the rest. A `retract_pending` row with no `ncmec_report_id` → `withdrawn` with no call.
  - For each report, inside one invocation:
    1. **Window check** (`submitted` only): `now > max(opened_at + 24 h, last_modified_at + 1 h)` → abandon (append the id, clear file ids and `fileinfo_sent`, set `pending`).
    2. `pending` → build the XML from the case's data (uploader `users.email`, `profiles.username`, profile URL `https://community.thinkersjournal.com/@<handle>`, embedding post URLs from `csam_case_targets` joined to posts and profiles, `incidentDateTime` = the uploader's earliest matched `media.created_at`). **INSERT the `ncmec_submissions` row before calling `submit`** (the bytes are preserved even if the call dies), then call it. On `ok`, set `ncmec_report_id`, `opened_at = last_modified_at = now`, `status = 'submitted'`, and backfill `ncmec_submissions.ncmec_report_id`.
    3. Each file lacking `ncmec_file_id` → `MEDIA_RESTRICTED.get(r2_key)` → `upload` → store `ncmec_file_id`, touch `last_modified_at`. A missing object is a `transport_error`-style failure with `last_error = 'object missing from MEDIA_RESTRICTED: <key>'`: it retries, and it alarms through condition 3 at 6 h.
    4. Each file with `fileinfo_sent = false` → `fileinfo` (with that row's `viewed_by_esp`) → set it true.
    5. `finish` → `finished`, `finished_at`.
  - Any `ncmec_error 5001` at steps 3–5 → abandon and continue as in step 1. Any `ncmec_error 4100` → `failed`, stop this report. `ncmec_error 2000|3100` → record it, **stop the whole tick**. `transport_error` → record it and back off (`attempts++`, `next_attempt_at = now + NCMEC_BACKOFF_MINUTES[min(attempts-1, last)]` minutes). Every successful NCMEC call updates `last_modified_at`, and every outcome writes `last_response_code`/`last_error` (cleared on success).
  - Each state transition is its own short `withClient` write. **No transaction spans a network call** (`BEGIN_BOUNDED_TX`'s 10 s idle timeout would kill it).
  - In `apps/api/src/index.ts`'s `*/2 * * * *` branch (`:90-92` at `9a76b6f`), add `ctx.waitUntil(runNcmecDrain(env, ctx));` next to `runMediaBackfillBatch`.
- [ ] **Step 4:** run → PASS; run the mutation; commit `feat(csam): the NCMEC drain — resumable, window-aware, retracts on a clear, never silent about credentials (Part of #114)`.

---

### Task 8: Alarms and case escalation

**Files:** create `apps/api/src/csam/alarms.ts`; modify `apps/api/src/index.ts` (add an explicit `if (controller.cron === "0 14 * * *")` call to the daily alarm check. Today there is no such branch, only the `disposition` ternary at `:93` before the unconditional email drain; keep that drain unchanged), `drain.ts` (immediate emails, the case tick and the log line), `apps/api/src/routes/admin-csam.ts` (`GET /admin/csam/alarm`, created here if Task 9 hasn't run yet); test `apps/api/test/csam-alarms.test.ts`.

**Produces:** `csamAlarmState(c, now): Promise<{ raised: boolean; counts: { awaitingCredentials: number; failed: number; overdueReports: number; abandonedUnfinished: number; credentialRejected: number; undecidedCases: number; overdueCases: number } }>`; `sendCsamAlarmEmail(env, state): Promise<boolean>`; `sendCaseAlarm(env, ctx, caseId, now?): Promise<boolean>`; `runCaseEscalation(env, ctx, now?): Promise<{ sent: number }>`. In `config.ts`, each marked `// DRAFT DEFAULT — awaiting CireSnave's OK (board item 125), spec §6.2`:

```ts
export const CSAM_REVIEW_TARGET_HOURS = 24;
export const CSAM_ALARM_REPEAT_HOURS = 4;            // known_hash cases
export const CSAM_CLASSIFIER_ALARM_REPEAT_HOURS = 24; // classifier cases (a proposal)
export const CSAM_OVERDUE_SUBJECT_PREFIX = "OVERDUE";
export const CSAM_REPORT_OVERDUE_HOURS = 6;           // §6 condition 3 (unchanged)
```

`CSAM_ALARM_EMAIL` is a **Worker secret supplied by the operator** (`env.CSAM_ALARM_EMAIL`), never a constant. If it is missing, every alarm email is skipped with an `ncmec ALARM` log line naming the missing secret, and the banner shows it.

- [ ] **Step 1: Failing test.** One case per §6 condition (1–6), each seeding exactly that condition and asserting its count is 1 and `raised` is true. **Mutation per condition:** remove that condition's term from the query → its case FAILS (AC-C4; report all six). Plus:
  - a clean state → `raised: false`, all zeros;
  - `GET /admin/csam/alarm` is Access-gated and returns the state;
  - the `0 14 * * *` tick sends exactly one report-alarm email when conditions 1–5 hold and none when clear;
  - ⚠️ **RF5:** a drain tick that **records** a `2000` sends the immediate alarm email **on that tick**, and so does one that sets `failed`. A later tick, with the condition still raised, sends **no** immediate email; the daily one covers it. Implement "first raised" as `last_response_code` changing to 2000/3100, or `status` changing to `failed`, within this tick;
  - every drain tick while raised logs one line starting with `ncmec ALARM` (spy on `console.error`);
  - ⚠️ **AC-C16, escalation**, with `now` passed explicitly: a `known_hash` case created at T sends its URGENT email at T (subject starts `URGENT`), none at T+2 min, one at T+4 h, one at T+8 h, …; at T+24 h+ the subject starts with `OVERDUE`. A `classifier` case repeats at T+24 h, not T+4 h. A decided case sends nothing. **No tick ever changes `review_outcome`, `disabled_at` or a hold**: assert all three unchanged after a run at T+72 h. **Mutation:** drop the `alarm_next_at` advance → the T+2 min tick sends a second email → FAIL;
  - the email body names the case link and the kind only: no image, sha256, handle, user id or email (assert none of the seeded values appear);
  - with `CSAM_ALARM_EMAIL` unset, no email is attempted and the log line names it.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** One SQL statement computing all seven counts. Condition 3 is `status NOT IN ('finished','withdrawn') AND created_at < now - CSAM_REPORT_OVERDUE_HOURS` on `ncmec_reports.created_at` (the queueing time: the match for a match-time report, the CONFIRM otherwise). Condition 6 is `review_outcome IS NULL` on `csam_cases`; `overdueCases` additionally `created_at < now - CSAM_REVIEW_TARGET_HOURS`.
  `runCaseEscalation` (called from the drain tick): `UPDATE csam_cases SET alarm_next_at = $now + <repeat for kind>, alarms_sent = alarms_sent + 1, last_alarm_at = $now WHERE review_outcome IS NULL AND alarm_next_at <= $now RETURNING …`, **then** send one email per returned case (claim first, then send, so two overlapping ticks cannot double-send; a failed send resets `alarm_next_at = $now` so the next tick retries). `sendCaseAlarm` (intake's post-commit) runs the same claim for one case. Subjects: `URGENT: CSAM match needs review` (known_hash) / `CSAM review needed` (classifier), each prefixed `OVERDUE — ` past the target. The report alarm keeps its subject `"⚠ NCMEC reporting needs attention"`. All go out on the `"outbound"` stream with a link to `/admin/csam`.
- [ ] **Step 4:** run → PASS; mutations; commit `feat(csam): alarm conditions and case escalation — banner, URGENT and OVERDUE email, log line (Part of #114)`.

---

### Task 9: Admin routes — intake, list, reveal, CONFIRM, CLEAR, retry

**Files:** create or extend `apps/api/src/routes/admin-csam.ts`, `apps/api/src/csam/review.ts`; modify `apps/api/src/routes.ts`, `pipeline-exempt.ts`, `packages/shared/src/admin.ts` (wire types); test `apps/api/test/admin-csam-route.test.ts` (the admin JWT harness, copied **by symbol** from `admin-decision-route.test.ts`: imports, `TEAM`/`AUD`/`KID`, `b64url`, `b64urlJson`, all five module-scope `let`s, `makeJwt`, `ctxRun`, `call`, and the module-level `beforeEach`/`afterEach`), and `apps/api/test/csam-review.test.ts` (pool).

**Routes:**
- `POST /admin/csam/matches` `{ lines: string[] }` → each line goes through `sha256FromMatchInput`, then `runIntake({ source: "cloudflare_match", kind: "known_hash", … })`. Returns `200 { unrecognised: { line: number; text: string }[], result: IntakeResult }`. If every line is unrecognised: `400 INVALID_INPUT` with the list. **No silent drop.**
- `POST /admin/csam/cases` `{ subject: "post", subjectId }` → `runIntake({ source: "moderator", kind: "moderator_sighting", … })`, which runs CONFIRM in the same transaction (below).
- `GET /admin/csam` → undecided cases first (`urgent`, then `high`, oldest first), then the rest newest first; each with kind, source, age against `CSAM_REVIEW_TARGET_HOURS`, files (sha256, `revealed_at`, `evidence_key`), reports (status, `queued_by`, `ncmec_report_id`, `last_error`, `abandoned_report_ids`), re-upload attempts, review state, and whether a runbook follow-up is due (cleared, a `finished` report, `ncmec_followup_at IS NULL`).
- `POST /admin/csam/files/:id/reveal` → set `revealed_at`/`revealed_by` (once), log a `media_access` action naming the case, and return `{ sha256 }`. The image itself still goes only through `GET /media/restricted/:sha256` and #61's two-person grant (`media-restricted.ts:81-135`). Reveal records that the reviewer looked; it does not bypass the grant.
- `POST /admin/csam/:caseId/confirm` `{ statement }` (non-blank) → `confirmCase(...)`.
- `POST /admin/csam/:caseId/clear` `{ statement }` (non-blank) → `requestClear(...)` for a `known_hash` case, `clearCase(...)` directly for a `classifier` case.
- `POST /admin/csam/:caseId/clear/approve` → `clearCase(...)`; refused `409 CSAM_SAME_HAND` when `sameAdminHand(approver, clear_requested_by)`.
- `POST /admin/csam/:caseId/ncmec-followup` → set `ncmec_followup_at`/`_by` (the runbook step was done).
- `POST /admin/csam/reports/:id/retry` → `failed` → `pending`, with `attempts = 0` and a log line. Any other status → `409 CSAM_NOT_RETRYABLE`.

Add `CSAM_NOT_RETRYABLE`, `CSAM_SAME_HAND`, `CSAM_ALREADY_DECIDED` and `CSAM_NOT_REVEALED` to the `ApiErrorCode` union, each with a one-line comment, the way plan A added its codes.

**`review.ts`:**
- **`confirmCase(env, ctx, { caseId, statement, actorAdmin })`** (spec §3.5), one transaction: lock the case `FOR UPDATE`; refuse a decided case (`CSAM_ALREADY_DECIDED`) and one with any unrevealed file (`CSAM_NOT_REVEALED`); for each uploader, `applyAccountActionInTx(c, { kind: "terminate", reason: <fixed text>, subjectLabel: <handle>, … })`; for each uploader with no `ncmec_reports` row for this case (`ncmec_reports_one_per_uploader`), queue one (`queued_by = 'confirm'`, files `viewed_by_esp = true`); keep every hold; write `csam_review`; set `review_outcome = 'confirmed'`, `priority = 'decided'`, `alarm_next_at = NULL`. Epoch bump for every uploader **before** the transaction and again **after** commit (`account-actions.ts:8-11`). No notice (A3).
- **`requestClear(...)`**: set `clear_requested_by`/`_at` and the statement on an undecided `known_hash` case; nothing else changes and the alarm continues.
- **`clearCase(env, ctx, { caseId, statement, actorAdmin })`** (spec §7.2):
  1. Before the transaction: for each case file, `MEDIA_RESTRICTED.get(r2_key)` → `put` to `evidence/csam/<caseId>/<sha256>.webp` → `head` it. Any failure aborts the clear with a 503 and changes nothing (re-running is idempotent).
  2. One transaction: lock the case; refuse a decided case; for a `known_hash` case require `clear_requested_by` and a different hand; set `evidence_key` on each file; `imposeLegalHold` on each evidence key (category `csam`, the case's `hold_action_id`); write the `csam_clear_release` action; for each serving key, `INSERT INTO media_legal_hold_releases … SELECT … FROM media_legal_holds WHERE r2_key = $1` then `DELETE FROM media_legal_holds WHERE r2_key = $1`; `applyDecisionInTx(c, { decision: "restore", … })` for every post in `csam_case_targets`; reports: `awaiting_credentials|pending|failed` → `withdrawn`, `submitted` → `retract_pending`, `finished` untouched; write `csam_review`; set `review_outcome = 'false_positive'`, `priority = 'decided'`, `alarm_next_at = NULL`.
  3. After commit: `afterContentDecision(env, ctx, { subject: "post", decision: "restore", reason, result })` **without** `legalHold` for each restored post. With the hold gone, `applyMediaVisibilityChange` moves each key back to `MEDIA` (`visibility-hook.ts:64-65`). For a key no post embeds, `enqueueAndAttemptMove(env, ctx, key, "to_public")`.
  The account is not touched (nothing was barred), and the `csam` account hold stays (`account-holds.ts:162`; spec §7.3).

- [ ] **Step 1: Failing tests.** Cases, each written out in full:
  - the gate (cross-site 403, no JWT 401) on each POST;
  - matches: a mixed paste returns exactly the unrecognised lines with their line numbers, and an all-garbage paste → 400 with the list;
  - list shape and order (an undecided `urgent` case above an undecided `high` one above a decided one);
  - reveal: logs `media_access` once, and is idempotent for `revealed_at`;
  - **CONFIRM** before every file is revealed → 409 `CSAM_NOT_REVEALED`. After reveal: every uploader is terminated (`disabled_reason = 'terminate'`) and gets 403 on login; a known-hash case gains **no** second report (its match-time one stands); a classifier case gains one report per uploader with `queued_by = 'confirm'` and `viewed_by_esp = true`; holds unchanged; the alarm stops. no appeal token is minted (A3), and a terminate is not appealable anyway (`routes/appeals.ts:54-60`; `moderation/appeals.ts:197-202` never lifts one);
  - **Both branches of `CSAM_REPORT_AT_MATCH` at CONFIRM:** with a known-hash case seeded as if the flag were `false` (no match-time report), CONFIRM queues one; the pure `queuesReportAtMatch` covers the flag itself;
  - ⚠️ **CLEAR, known-hash (AC-C15):** a clear by one admin only records the request (the case is still undecided and still alarming); approval by the **same** admin (case-insensitive, `Alice@x` vs `alice@x`) → 409 `CSAM_SAME_HAND`; approval by a second admin → the posts are publicly visible again, `env.MEDIA.get(key)` is not null, `evidence/csam/<caseId>/<sha256>.webp` exists in `MEDIA_RESTRICTED` under a `csam` hold, the serving key has no `media_legal_holds` row and one `media_legal_hold_releases` row, the uploader's account columns are unchanged and their `csam` account hold remains;
  - **CLEAR, report states:** a `pending` report → `withdrawn` and the NCMEC double receives **no** call; a `submitted` one → `retract_pending` (Task 7 retracts it); a `finished` one is unchanged and still listed, with "runbook follow-up due";
  - **CLEAR, classifier:** one admin suffices;
  - **CLEAR then re-detect:** the same key pasted again → `already_cased` naming the cleared case, no new case, report, hold or alarm (AC-C10, AC-C15);
  - **Evidence copy failure:** with `MEDIA_RESTRICTED.put` stubbed to throw, the clear returns 503 and the case, holds, posts and reports are unchanged;
  - a second decision on a decided case → 409 `CSAM_ALREADY_DECIDED`;
  - retry: only from `failed`;
  - and make Task 6's `it.todo` (moderator sighting) real.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS. **Step 5:** commit `feat(csam): admin intake, list, reveal, CONFIRM, two-person CLEAR, retry (Part of #114)`.

---

### Task 10: The admin UI

**Files:** create `apps/web/src/pages/admin/csam.astro`; modify the admin pages' shared header (or each of `admin/queue.astro`, `admin/media-access.astro`, `admin/accounts/[handle].astro`, `admin/appeals.astro`, `admin/dsa-notices.astro` if they share none) to render the alarm banner; modify `admin/queue.astro` and `admin/accounts/[handle].astro` for a "Report as CSAM" control; test `apps/web/test/admin-csam-page.test.ts`.

- The page is modelled on `admin/media-access.astro` (Access guard first, `markPrivate`, `setPublicPageCsp`). It has:
  - a textarea "Paste the matched paths from Cloudflare's email, one per line" → POST matches, showing the unrecognised lines;
  - the case list, undecided first, each with its kind (`known hash` / `classifier`), age against the 24 h target (red once OVERDUE), report status and NCMEC id once filed, and any re-upload attempts;
  - per file, a **blurred placeholder** (no `<img>` at all until revealed). A "Reveal" form POSTs reveal and then links to the two-person media-access page for that sha256. The page never embeds the image directly;
  - per undecided case, a **Confirm** form and a **Clear** form, each with a required statement. Confirm is disabled until every file is revealed. A known-hash clear shows "awaiting a second admin" with an **Approve clear** button for anyone but the requester;
  - per cleared case with a finished report, "Runbook follow-up due" and a button recording it was done;
  - per failed report, "Retry after fix".
- **Banner:** every admin page fetches `GET /admin/csam/alarm` after its guard and, when `raised`, renders a red `role="alert"` banner with the counts (undecided and OVERDUE cases first), linking to `/admin/csam`.
- "Report as CSAM" on a queue item or the account page POSTs `/admin/csam/cases` for that post after a confirm checkbox.
- [ ] **Step 1: Failing source pins:**
  - the guard is the first statement on `csam.astro`;
  - `csam.astro` contains **no `<img`**;
  - every admin page includes the banner fetch;
  - the queue's CSAM control is a separate form, not a button on the decision form (spec decision #3's spirit: no accidental CSAM filing from the decide buttons);
  - Confirm and Clear are separate forms, so no single click can do the wrong one.
- [ ] **Step 2:** implement; run → PASS; `pnpm typecheck`; commit `feat(web): CSAM admin page, alarm banner on every admin page (Part of #114)`.

---

### Task 11: Runbook, XSD check, and the exttest run

**Files:** create `docs/runbooks/csam.md`, `apps/api/scripts/ncmec-exttest.mjs`; modify `apps/api/src/csam/ncmec-xml.ts` if the XSD disagrees; docs (`docs/legal/community-guidelines.md` §1.2 status note, `docs/legal/privacy-policy.md` §4 note).

- [ ] **Runbook** `docs/runbooks/csam.md`, one section each:
  - reading Cloudflare's daily email and pasting it;
  - lifting Cloudflare's own block (Security Center → Blocked Content; dashboard only);
  - a false positive: the two-person CLEAR in-app; then, if any report reached `finished`, tell NCMEC out of band through the contact channel NCMEC gave at enrolment, naming the report id and stating that our human review found no violation, and record it with the follow-up button. NCMEC's API has no amend or withdraw call after `/finish` (spec §7.2). ⚠️ Legal uncertainty, as the spec states it; there is no attorney;
  - what an URGENT or OVERDUE case email means, and the 24 h review target (a draft default, spec §6.2);
  - a law-enforcement **destruction** request (§2258B(c)): who, the two-person rule, deleting the R2 object and its `csam_case_files` row by hand, and recording it;
  - setting and rotating the secrets: the NCMEC pair, the four `NCMEC_REPORTER_*` values and `CSAM_ALARM_EMAIL`, all via `wrangler secret put`, by the operator; never pasted into a file, commit, PR or chat log;
  - what each alarm means and what to do about it.
- [ ] **XSD check:** with exttest credentials, `GET <exttest>/xsd`, saved to `docs/superpowers/specs/ncmec-ispws.xsd`. Correct `ncmec-xml.ts`'s element names and order to it (including the reporter's phone and address elements and how a name is split), update its tests, and remove the "checked in Task 11" comment.
- [ ] **`ncmec-exttest.mjs` (AC-C8):** run against `exttest.cybertip.org` with the real exttest credentials (from env, never committed). It drives a real `submit` → `upload` (a harmless test image NCMEC's docs permit for exttest; read their instructions first) → `fileinfo` → `finish` through the **production code path** (import the built client, or run the drain against a seeded case in the dev DB), and prints the NCMEC report id and the final response. The PR body pastes that output. **APP.live does not flip until it shows `finished`** (spec AC-C8).
- [ ] **Docs:** replace #122's `[[NOT YET TRUE …]]` notes that this work makes true:
  - automatic NCMEC reporting (now true: at the match for known-hash matches, at confirmation otherwise);
  - account termination for CSAM (true **on a moderator's confirmation**; per R1 a match alone quarantines the content and leaves the account active);
  - Cloudflare scanning (still bracketed until CireSnave confirms R2 coverage).
- [ ] Commit `docs(csam): runbook; XSD-verified element names; exttest end-to-end (Part of #114)`. ⚠️ Only this PR's body carries GitHub's closing keyword for the issue, and only with AC-C8's output and AC-C6's two quoted rulings in it.

## Whole-branch checks

- [ ] `pnpm typecheck`; `pnpm -r run test` green except the four known local `media-backfill.test.ts` timeouts (same four by name); `pnpm run test:e2e` green.
- [ ] Merge conditions AC-C1…AC-C17 each named in the PR body with the test or evidence that shows it. The mutation results from Tasks 4, 6, 7 and 8 are listed.
- [ ] AC-C6: `CSAM_BAR_UNREVIEWED_MATCH = false` and `CSAM_REPORT_AT_MATCH = true`, each with CireSnave's ruling quoted verbatim above it and in the PR body.
- [ ] `git grep` the branch for anything that looks like a real contact value (an email outside `example.test`/`example.com`, a phone number, a street address). There must be none (AC-C13).
- [ ] Deploy note: the migration before the code; the operator sets `NCMEC_USERNAME`, `NCMEC_PASSWORD`, `NCMEC_BASE_URL`, the four `NCMEC_REPORTER_*` values and `CSAM_ALARM_EMAIL` with `wrangler secret put` before the first deploy that drains (until then, every report alarms as `awaiting_credentials`, by design). `NCMEC_BASE_URL` points at **exttest** until AC-C8 has shown `finished`; only then does it change to production.
- [ ] The PM allocates the version number at gate time (portfolio rule); no PR here bumps it.
