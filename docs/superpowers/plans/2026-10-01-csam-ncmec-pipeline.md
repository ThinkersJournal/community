# CSAM Detection → NCMEC Reporting Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a detection (a Cloudflare or self-scan known-hash match, or a future classifier flag) or a moderator's sighting enters the system, the matched content is quarantined at once, the evidence is preserved from that moment, the uploader's account **stays active** (R1), a priority review case opens with an URGENT alarm, and, for a known-hash match, a CyberTipline report is filed automatically within about 2 minutes ("Option B"). A moderator's CONFIRM terminates the uploader and queues any report not yet queued; a CLEAR lifts the quarantine. Any report that doesn't reach "filed", and any case nobody has decided, raises an alarm.

**Architecture:** One intake transaction writes every local consequence (quarantine, holds, snapshots, the case and its alarm) and, for a known-hash match, queues one `ncmec_reports` row per uploader. A CONFIRM or CLEAR is one more transaction. The existing `*/2 * * * *` cron drains those rows through NCMEC's ISP Web Services (submit → upload → fileinfo → finish) as a persisted state machine, resubmitting when NCMEC's deletion window has passed. Alarm conditions are computed from the same tables and surfaced in three ways: a red banner on every admin page, an email, and a log line.

**Tech Stack:** TypeScript on Cloudflare Workers (`apps/api`), Astro SSR (`apps/web`), Postgres via Hyperdrive, R2 (`MEDIA`, `MEDIA_RESTRICTED`), `fast-xml-parser` (exact pin), vitest (pool + Node projects), Postmark "outbound".

**Spec:** `docs/superpowers/specs/2026-10-01-csam-reporting-pipeline-design.md` (PR #130, approved by the PM; **revision 2**, 2026-10-04, applies R1 and "Option B" and needs the PM's approval again) and its research notes, `docs/superpowers/specs/2026-10-01-ncmec-research-notes.md`. **Read both.** Every "§n" below refers to the spec.

## Preconditions (do not start Task 1 until all hold)

Checked against `origin/main` at `9a76b6f` (0.1.4) on 2026-10-04:
- Plan A (#132) is merged: `applyAccountAction` (`apps/api/src/moderation/account-actions.ts:66`) and the account routes exist.
- Plan B (#144) is merged: `applyDecisionInTx` (`decide.ts:90`) and `afterContentDecision` (`after-content-decision.ts:29`) exist. ⚠️ `afterContentDecision`'s `legalHold` is `{ category, imposedBy }` (`:26`); it fills `moderationActionId` from `result.actionId` itself (`:50-53`), and the args also need `decision` and `reason`.
- #126 is merged (`moderation_snapshots`, `0021`). The account legal hold (#139) is merged: `imposeAccountHoldInTx` (`account-holds.ts:49`), and holds gate both reapers. #141's `RESERVED_EMAIL_KEY` HMAC (`0023`) and #145 (`0025`) are merged; nothing here touches them.
- `clientIp()` exists (`apps/api/src/http/client-ip.ts:23`) and is used only for rate-limiter keys; no IP is stored, so the report still carries none (spec §4.5).
- The migration below is **`0026_csam.sql`** (the last on main is `0025_drop_reserved_email_sha256.sql`). If another migration lands first, take the next free number.
- **The NCMEC credentials exist** (exttest at least). The implementation PRs wait for them.
- ⚠️ **At least two Access admins exist** (spec §0 precondition). Every two-person rule here (fetching held media, `media-restricted.ts:116-122`; clearing a known-hash case) is unusable with one, and a known-hash false positive would stay quarantined forever.

## Global Constraints

- TypeScript **6.0.3**. Errors go through `errorResponse` and the closed `ApiErrorCode` union.
- Admin routes: `checkOrigin` first (POST), then `requireAdmin`. Each new admin POST is added to `apps/api/test/helpers/pipeline-exempt.ts` with a reason.
- **R1: no machine detection bars anyone** (`CSAM_BAR_UNREVIEWED_MATCH = false`; AC-C14). Only a moderator's CONFIRM (or a moderator's own sighting) terminates.
- **"Option B": for a known-hash match, no human action between intake and NCMEC `submit`** (`CSAM_REPORT_AT_MATCH = true`; AC-C2). A **classifier** flag is never reported before CONFIRM, under either value.
- **No email to the uploader or author from any CSAM path** (A3; AC-C7).
- **The exact bytes sent to NCMEC are preserved for at least a year**, append-only, with no reaper (§2258A(h); spec §5).
- XML responses: **byte cap before parse**. `fast-xml-parser` is pinned **exactly** (no `^`), and the characterisation test passes against that pin (AC-C12). Request XML is built with an escaper, never parsed.
- Secrets `NCMEC_USERNAME`, `NCMEC_PASSWORD`, `NCMEC_REPORTER_NAME`, `NCMEC_REPORTER_EMAIL`, `NCMEC_REPORTER_PHONE`, `CSAM_ALARM_EMAIL`, and the optional address group `NCMEC_REPORTER_STREET`, `_CITY`, `_STATE`, `_ZIP`, `_COUNTRY` (all five or the `<address>` element is omitted); var `NCMEC_BASE_URL`, with **no default**. All are **supplied by the operator as secrets**. ⚠️ **Never write a real name, email, phone or address into code, tests, docs, commits or PR text**; tests use obviously fake values (`reporter@example.test`). If any required NCMEC value is missing or blank, the system is "not configured" and reports sit in `awaiting_credentials`, which alarms.
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
10. **Only matched keys are held** (AC-C9): an innocent image in the same hidden post is never held, and a CLEAR restores only content that was visible at the match and releases only the case's own holds (AC-C18). Pinned in Tasks 6 and 9.
11. **A second sighting** of a key with an open case attaches to it; it must never hit the unique index as a 500 (AC-C10). Pinned in Task 6.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/api/src/media/key-pattern.ts` (modify) | The one media-key pattern (SQL + JS), plus `sha256FromMatchInput`. |
| `apps/api/src/media/reachability.ts`, `reap-orphan-media.ts` (modify) | Use the shared pattern; drop their private copies. |
| `apps/api/src/moderation/account-actions.ts` (modify) | Split out `applyAccountActionInTx`. |
| `apps/api/src/media/reap-orphan-media.ts`, `apps/api/src/routes/media.ts` (modify) | Task 2a: skip held keys in the reaper; refuse a held key on upload. |
| `apps/api/migrations/0026_csam.sql` (create) | The `csam_hold`/`csam_review`/`csam_clear_release` action kinds; `csam_cases`, `csam_case_files`, `csam_case_targets`, `csam_upload_attempts`, `csam_unmatched_digests`, `ncmec_reports`, `ncmec_report_files`, `ncmec_submissions`, `media_legal_hold_releases`. |
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
| `apps/api/migrations/0027_media_original_hashes.sql`, `apps/api/src/routes/media.ts` | Task 12, **gated on board item 126**: the original upload's MD5/SHA-1/SHA-256. |
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
  - `csam_case_files` has the **partial** unique index `csam_case_files_live_key` on `(r2_key) WHERE cleared_at IS NULL`: two live rows for one key fail (whatever their kinds); a second row for a key whose first row has `cleared_at` set succeeds.
  - `csam_case_targets.subject` accepts only `post|comment`.
  - `csam_unmatched_digests.sha256` must be 64 lowercase hex.
  - `ncmec_reports.status` accepts exactly `awaiting_credentials|pending|submitted|finished|failed|retract_pending|withdrawn`.
  - `ncmec_submissions`: UPDATE refused, DELETE of a row younger than 1 year refused, a control DELETE at 366 days allowed, TRUNCATE refused. Same guard shape as `0021`'s `moderation_snapshots`.
  - `media_legal_hold_releases` and `csam_upload_attempts`: UPDATE and TRUNCATE refused (append-only); a control INSERT succeeds.
  - `media_access_requests.case_file_id` exists, is nullable, and an existing-shape insert without it still succeeds.
  - `csam_alarm_marks` is unique on `(condition, ref)`.
  - none of these tables has an FK to `users`, `posts` or `media` (evidence outlives its subject; the same reasoning as 0013). Control: `reports` does.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Migration.**

```sql
-- Up Migration
--
-- #114 — the CSAM → NCMEC pipeline (spec 2026-10-01-csam-reporting-pipeline-design.md, revision 2).
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

CREATE TABLE csam_case_files (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id       uuid NOT NULL REFERENCES csam_cases(id),
  r2_key        text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('known_hash', 'classifier', 'moderator_sighting')),
  sha256        text NOT NULL,
  revealed_at   timestamptz,               -- the Reveal button only; never "viewed" (spec §3.1)
  revealed_by   text,
  seen_by       text,                      -- a moderator's attested sighting (spec §3.6)
  seen_at       timestamptz,
  evidence_key  text,                      -- set by a CLEAR (spec §7.2)
  cleared_at    timestamptz,               -- set by a CLEAR; frees the key for a later case
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- ⚠️ At most ONE live case file per key (spec §3.6; AC-C10). Partial, so a
-- cleared key can open a new case. Disposition is decided in code first
-- (intakeDisposition); this index is the backstop, not the control.
CREATE UNIQUE INDEX csam_case_files_live_key ON csam_case_files (r2_key) WHERE cleared_at IS NULL;

-- The content this case hid that was VISIBLE at the match (result.wasHidden
-- false), so a CLEAR restores exactly that and nothing hidden for another reason.
CREATE TABLE csam_case_targets (
  case_id    uuid NOT NULL REFERENCES csam_cases(id),
  subject    text NOT NULL CHECK (subject IN ('post', 'comment')),
  subject_id uuid NOT NULL,                -- bare
  -- Set by a CLEAR that left this target hidden because it still embeds a key
  -- another live or confirmed case holds (spec §7.2 step 3).
  restore_skipped_case_id uuid,
  PRIMARY KEY (case_id, subject, subject_id)
);

-- A grant opened by Reveal names its case file, so "viewed" is keyed on the
-- grant, never on a clock window (spec §3.1). Nullable: #61's own grants have none.
ALTER TABLE media_access_requests ADD COLUMN case_file_id uuid;  -- bare

-- "First raised" for alarm conditions 7 and 8 (spec §6.3): one row per
-- (condition, item) the tick has already emailed about.
CREATE TABLE csam_alarm_marks (
  condition        smallint NOT NULL CHECK (condition IN (7, 8)),
  ref              uuid NOT NULL,          -- csam_unmatched_digests.id or media_moves.id
  first_raised_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (condition, ref)
);

-- A recognised digest that matched no media row (spec §5, §6 condition 7):
-- its evidence may already have been reaped. Alarms until acknowledged.
CREATE TABLE csam_unmatched_digests (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  source           text NOT NULL CHECK (source IN ('cloudflare_match', 'self_scan', 'moderator')),
  reported_by      text NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_by  text,
  acknowledged_at  timestamptz,
  acknowledgement  text
);

-- A re-upload of a csam-held file (spec §3.7). Append-only.
CREATE TABLE csam_upload_attempts (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id      uuid NOT NULL REFERENCES csam_cases(id),
  user_id      uuid NOT NULL,              -- bare
  r2_key       text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION csam_upload_attempts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'csam_upload_attempts is append-only (#114): % refused', TG_OP;
END;
$$;
CREATE TRIGGER csam_upload_attempts_no_update
  BEFORE UPDATE ON csam_upload_attempts
  FOR EACH ROW EXECUTE FUNCTION csam_upload_attempts_guard();
CREATE TRIGGER csam_upload_attempts_no_truncate
  BEFORE TRUNCATE ON csam_upload_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION csam_upload_attempts_guard();

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
  imposed_at           timestamptz NOT NULL, -- copied from media_legal_holds.created_at (0016:25)
  moderation_action_id uuid,              -- the hold's own action
  case_id              uuid NOT NULL REFERENCES csam_cases(id),
  release_action_id    uuid NOT NULL,     -- the csam_clear_release action
  released_by          text NOT NULL,     -- the approving hand
  requested_by         text NOT NULL,     -- the requesting hand
  released_at          timestamptz NOT NULL DEFAULT now()
);
-- Append-only: no UPDATE, no TRUNCATE. The same three statements as
-- csam_upload_attempts_guard above, named media_legal_hold_releases_guard /
-- _no_update / _no_truncate.

-- Down Migration
DROP TABLE IF EXISTS media_legal_hold_releases;
DROP FUNCTION IF EXISTS media_legal_hold_releases_guard();
DROP TABLE IF EXISTS ncmec_submissions;
DROP FUNCTION IF EXISTS ncmec_submissions_guard();
DROP TABLE IF EXISTS ncmec_report_files;
DROP TABLE IF EXISTS ncmec_reports;
DROP TABLE IF EXISTS csam_upload_attempts;
DROP TABLE IF EXISTS csam_unmatched_digests;
DROP TABLE IF EXISTS csam_alarm_marks;
ALTER TABLE media_access_requests DROP COLUMN IF EXISTS case_file_id;
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

Add `| "csam_hold" | "csam_review" | "csam_clear_release"` to `ModerationActionKind` (`actions.ts`) with a one-line comment each. Add up/down `tableExists` assertions for the ten tables to `migrations.db.test.ts`, and an up/down assertion for `media_access_requests.case_file_id`.
- [ ] **Step 4:** run → PASS; commit `feat(db): CSAM cases, NCMEC reports and preserved submissions (Part of #114)`.

---

### Task 4: The XML layer, and the pinned parser

**Files:** modify `apps/api/package.json`; create `apps/api/src/csam/ncmec-xml.ts`, `apps/api/test/ncmec-xml.node.test.ts`, `apps/api/test/fast-xml-parser-characterisation.node.test.ts`.

**Produces:** `buildReportXml(input: ReportXmlInput): string`, `buildFileDetailsXml(input: FileDetailsInput): string`, `parseNcmecResponse(body: Uint8Array): NcmecResponse` (throws `NcmecResponseTooLarge` above `NCMEC_RESPONSE_MAX_BYTES`), `readCapped(res: Response, max: number): Promise<Uint8Array>`.

- [ ] **Step 1: The dependency.** Add `"fast-xml-parser": "<exact version apps/web pins>"` to `apps/api/package.json` dependencies, **without `^`**. It's `5.11.2` at `9a76b6f` (`apps/web/package.json:25`); read `apps/web/package.json` and use its value. Run `pnpm install`.
- [ ] **Step 2: The characterisation test (AC-C12).** Create `fast-xml-parser-characterisation.node.test.ts`. Read `docs/superpowers/specs/2026-09-08-xml-parser-decision.md` §3–§4 and encode **each** probe it ran: the external-entity file reference (must throw), nested entity expansion (must not expand, returned literally), deep nesting at 1 000 (must throw "Maximum nested tags exceeded"), a benign document (parses), and an NCMEC-shaped response (parses to the expected object). Each runs against the installed version, configured exactly as `ncmec-xml.ts` will configure it (`processEntities: false`). Its header states: **if any of these fails after a version bump, that is a STOP**, not a test to adjust (spec §4.3).
- [ ] **Step 3: Failing XML-layer test** (`ncmec-xml.node.test.ts`). Cases, each written out in full:
  - `buildReportXml` escapes `& < > " '` in every interpolated field (a screen name like `a<b&"c'`), and the output starts with `<?xml version="1.0" encoding="UTF-8"?>`.
  - it emits the incident type, the incident time (ISO-8601), the reporting person's name, email and phone, the structured `<address>` (street, city, state, zip, country) **when given**, and **no `<address>` element at all** when `reporter.address` is null; and the reported person's `espIdentifier`, `screenName`, `profileUrl` and `email`. **No IP element appears** (we hold none; spec §4.5). Fixtures use fake values only (`Test Reporter`, `reporter@example.test`, `+1 555 0100`, `1 Example Way`, `Testville`, `TS`, `00000`, `US`).
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

export interface ReporterAddress {
  readonly street: string;
  readonly city: string;
  readonly state: string;
  readonly zip: string;
  readonly country: string;
}

export interface ReporterContact {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
  /** null when any of the five address secrets is unset: the element is then omitted (spec §4.4). */
  readonly address: ReporterAddress | null;
}

export interface ReportXmlInput {
  readonly incidentDateTime: Date;
  /** From the NCMEC_REPORTER_* secrets (Task 5's ncmecConfig). Never a literal in code. */
  readonly reporter: ReporterContact;
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
    addressXml(i.reporter.address) +
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

/** The optional structured address; omitted entirely, never half-filled. Element names checked in Task 11. */
function addressXml(a: ReporterAddress | null): string {
  if (a === null) return "";
  const e = escapeXml;
  return (
    `<address>` +
    `<street>${e(a.street)}</street><city>${e(a.city)}</city><state>${e(a.state)}</state>` +
    `<zipCode>${e(a.zip)}</zipCode><country>${e(a.country)}</country>` +
    `</address>`
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
  readonly reporter: ReporterContact; // NCMEC_REPORTER_NAME/EMAIL/PHONE, and the five address secrets
}
export function ncmecConfig(env: Env): NcmecConfig | null; // null when any of the six REQUIRED values is missing or blank
export type NcmecCall =
  | { readonly kind: "ok"; readonly response: NcmecResponse }
  | { readonly kind: "ncmec_error"; readonly response: NcmecResponse }      // a non-zero responseCode
  | { readonly kind: "transport_error"; readonly status: number | null; readonly error: string }; // network, 5xx, cap, unparseable
export function submit(cfg: NcmecConfig, xml: string): Promise<NcmecCall>;
// ⚠️ ArrayBuffer, not ReadableStream: a FormData part must be a Blob or string. The drain buffers one object at a time.
export function upload(cfg: NcmecConfig, reportId: string, fileName: string, body: ArrayBuffer): Promise<NcmecCall>;
export function fileinfo(cfg: NcmecConfig, xml: string): Promise<NcmecCall>;
export function finish(cfg: NcmecConfig, reportId: string): Promise<NcmecCall>;
export function retract(cfg: NcmecConfig, reportId: string): Promise<NcmecCall>; // only before finish; 5102 after
```

- [ ] **Step 1: Failing test.** Stub `fetch` (the `vi.stubGlobal` idiom from `test/moderation-notify.test.ts`), capturing method, URL, headers and body. Cases, each written out in full:
  - `ncmecConfig` → null when any of the six required values (`NCMEC_BASE_URL`, `NCMEC_USERNAME`, `NCMEC_PASSWORD`, `NCMEC_REPORTER_NAME`, `NCMEC_REPORTER_EMAIL`, `NCMEC_REPORTER_PHONE`) is missing or blank (one case per variable); otherwise the trimmed base URL with no trailing slash, and the reporter. `reporter.address` is the five `NCMEC_REPORTER_STREET`/`_CITY`/`_STATE`/`_ZIP`/`_COUNTRY` values when **all five** are non-blank, and `null` when **any** is unset or blank (one case: four set, one blank → `null`). `NCMEC_REPORTER_NAME` is split at its **first** whitespace into `firstName`/`lastName` (a one-word name gives an empty `lastName`; Task 11's XSD check may change this). Add the twelve new names (the eleven NCMEC ones and `CSAM_ALARM_EMAIL`) to `worker-configuration.d.ts` the way `RESERVED_EMAIL_KEY` is declared there (`:46-48`).
  - `submit` POSTs `<base>/submit` with `content-type: text/xml; charset=utf-8` and `Authorization: Basic base64(user:pass)`; a `responseCode 0` body → `ok` with `reportId`.
  - `upload` POSTs `<base>/upload` as `multipart/form-data` with fields `id=<reportId>` and `file=new Blob([body]), fileName` → `ok` with `fileId`; the captured part's bytes equal the input `ArrayBuffer`.
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
// config.ts — each constant sits under CireSnave's ruling, quoted verbatim: paste the two comment
// blocks from spec §3.4 exactly as they appear there (R1's full text; "Option B.").
export const CSAM_BAR_UNREVIEWED_MATCH = false;
export const CSAM_REPORT_AT_MATCH = true;
export const CSAM_INTAKE_LOCK_ID = 114_000_001; // pg_advisory_xact_lock key
export const CSAM_SELF_SCAN_ACTOR = "system:self-scan";
export const CSAM_QUARANTINE_REASON = "Hidden pending a child-safety review.";

// intake.ts
export type DetectionKind = "known_hash" | "classifier" | "moderator_sighting";
export type CaseOutcome = "undecided" | "confirmed" | "false_positive";
export interface ExistingCaseFile { readonly caseId: string; readonly kind: DetectionKind; readonly outcome: CaseOutcome }
export type Disposition = "open" | "suppress" | "attach";
export type IntakeInput =
  | { readonly source: "cloudflare_match"; readonly kind: "known_hash"; readonly sha256s: readonly string[]; readonly actorAdmin: string }
  | { readonly source: "self_scan"; readonly kind: "known_hash" | "classifier"; readonly sha256s: readonly string[]; readonly actorAdmin: string }
  | { readonly source: "moderator"; readonly kind: "moderator_sighting"; readonly subject: "post" | "comment"; readonly subjectId: string; readonly statement: string; readonly actorAdmin: string };
export type IntakeResult =
  | { readonly kind: "opened"; readonly caseId: string; readonly reports: number; readonly hiddenItems: number; readonly heldAccounts: number; readonly unmatched: number }
  | { readonly kind: "already_cased"; readonly cases: readonly { readonly caseId: string; readonly outcome: CaseOutcome; readonly attached: boolean }[]; readonly unmatched: number }
  | { readonly kind: "nothing_to_do"; readonly reason: "no_media_rows" | "subject_has_no_media" | "subject_not_found"; readonly unmatched: number };
export interface IntakeHooks {
  /** Tests only: runs immediately before COMMIT. */
  readonly beforeCommit?: (c: Client) => Promise<void>;
  /** Tests only: override the two constants, so BOTH values of BOTH are exercised end to end. */
  readonly barUnreviewedMatch?: boolean;
  readonly reportAtMatch?: boolean;
}
/** Pure. True only for known_hash with the constant true (spec §3.4). */
export function barsAtMatch(kind: DetectionKind, barUnreviewedMatch: boolean): boolean;
/** Pure. True only for known_hash with the constant true (spec §3.4). */
export function queuesReportAtMatch(kind: DetectionKind, reportAtMatch: boolean): boolean;
/** Pure. Spec §3.6's table; `existing` holds every case file for the key, live and cleared. */
export function intakeDisposition(kind: DetectionKind, existing: readonly ExistingCaseFile[]): Disposition;
/** Step 6 for one post or comment: lock, snapshot, keep_hidden, target if it was visible. null when the row is gone. */
export function quarantineItemInTx(c: Client, item: { readonly subject: "post" | "comment"; readonly subjectId: string; readonly caseId: string; readonly actorAdmin: string }): Promise<DecisionResult | null>;
export function runIntake(env: Env, ctx: ExecutionContext, input: IntakeInput, hooks?: IntakeHooks): Promise<IntakeResult>;
```

**The two constants (spec §3.4, AC-C6).** `config.ts` carries the two comment blocks of spec §3.4 verbatim above the constants, each crediting "relayed by the PM, 2026-10-04". Intake reads each constant **only** through its pure helper (`barsAtMatch`, `queuesReportAtMatch`), passing `hooks.barUnreviewedMatch ?? CSAM_BAR_UNREVIEWED_MATCH` and `hooks.reportAtMatch ?? CSAM_REPORT_AT_MATCH`. There is no placeholder anywhere: contact values are secrets (Task 5).

**Embedding content (spec §3.2):** posts **and comments** (`reachability.ts:36-39`, `:52-55`). Both are quarantined the same way; only uploaders are reported (R3). Say so in `intake.ts`'s header.

- [ ] **Step 1: Failing test.** Fixtures: seed `media` rows (owner, `r2_key`, sha256), put objects in `env.MEDIA`, and seed posts and comments whose markdown embeds them, reusing `reap-orphan-media.test.ts`'s `seedMedia`/`insertPost` idiom. Stub `env.WEB` for the cache purge as `admin-decision-route.test.ts` does, and stub Postmark to capture messages. Cases, each written out in full:
  - **(a) known-hash match; the post embeds the matched image M and an innocent image I:** `opened`. Then:
    - the post 404s through the **public** read route; `env.MEDIA.get(M)` is null and `env.MEDIA_RESTRICTED.get(M)` is not (AC-C1, AC-C9); `GET /media/restricted/:sha256` for M returns 404 to the author's session and to an admin without a grant, and 200 to an admin with an approved two-person grant (AC-C14);
    - M is in `media_legal_holds` with `category = 'csam'` and `moderation_action_id` = the case's `hold_action_id`; ⚠️ **I has no `media_legal_holds` row** (AC-C9), and I moved to `MEDIA_RESTRICTED` only because nothing visible still uses it (seed a second, visible post embedding I in a variant: then I stays in `MEDIA`);
    - a `moderation_snapshots` row exists for the post; its decision row is `content_keep_hidden`; one `csam_case_targets` row (`subject = 'post'`);
    - ⚠️ **AC-C14, the uploader is NOT barred:** `disabled_at`, `disabled_reason` and `suspended_until` equal their values before intake, the uploader's epoch did not move, a login as the uploader succeeds and a new post by them is accepted;
    - the uploader has an active `csam` row in `account_legal_holds` referencing `hold_action_id` (spec §3.3 step 7a, known-hash);
    - the case is `kind = 'known_hash'`, `priority = 'urgent'`, `alarm_next_at <= now()`;
    - one `ncmec_reports` row, `queued_by = 'match'`, `pending` or `awaiting_credentials` as the env implies, and one `ncmec_report_files` row with `viewed_by_esp = false`;
    - exactly one alarm email went to the fake `CSAM_ALARM_EMAIL`, and none to anyone else (AC-C7).
  - ⚠️ **A comment embedding M** (another user's comment on an unrelated post): the comment is hidden, snapshotted (`comment_id` set), and is a case target; its author has no account hold and no report (R3).
  - ⚠️ **Already-hidden content** (AC-C18): a post embedding M that was hidden **before** intake gets a snapshot and a `keep_hidden` decision, but **no** `csam_case_targets` row (`result.wasHidden === true`).
  - **Deleted mid-intake** (`applyDecisionInTx` returns `null`): call step 6's helper `quarantineItemInTx(c, { subject, subjectId, … })` inside a test transaction with the id of a post deleted after resolution. It returns `null` and writes no snapshot, decision or target, and the transaction is still open (the `SAVEPOINT` probe Task 2 uses).
  - **A classifier flag** (`self_scan`, `classifier`): the same quarantine, `priority = 'high'`, **zero** `ncmec_reports` rows, and ⚠️ **no `account_legal_holds` row** for the uploader (spec §3.3 step 7a: classifier cases take it at CONFIRM).
  - ⚠️ **Both values of BOTH constants (AC-C6):**
    - pure: `barsAtMatch("known_hash", true)` → true; `("known_hash", false)`, `("classifier", true)`, `("classifier", false)`, `("moderator_sighting", true)` → false. `queuesReportAtMatch("known_hash", true)` → true; `("known_hash", false)`, `("classifier", true|false)`, `("moderator_sighting", true|false)` → false;
    - end to end: a known-hash intake with `hooks.barUnreviewedMatch = true` terminates the uploader (`disabled_reason = 'terminate'`); with `false` (and with no hook, i.e. the constant as set) it does not. A known-hash intake with `hooks.reportAtMatch = false` queues no report; with `true` (and with no hook) it queues one;
    - `CSAM_BAR_UNREVIEWED_MATCH === false` and `CSAM_REPORT_AT_MATCH === true` as set.
  - ⚠️ **RF2 / AC-C9, an orphan upload** (no post or comment embeds the key): the object still leaves `MEDIA` for `MEDIA_RESTRICTED`, and the hold exists. **Mutation:** drop intake's explicit per-key `enqueueAndAttemptMove(…, "to_restricted")` → both this case and case (a)'s M assertion FAIL (nothing else moves a held key: the hook skips it at `visibility-hook.ts:56-57`).
  - ⚠️ **RF3 / AC-C11, a multi-uploader key plus a second key only one of them uploaded:** two reports. Uploader A's report carries both files; B's report carries only the shared one. Both A and B have `csam` account holds; neither is barred.
  - ⚠️ **RF1 / AC-C10, disposition:** run the same intake twice. The second returns `already_cased` naming the first case as `undecided`, `attached: false`; the counts of `csam_cases`, `ncmec_reports`, holds, `moderation_actions` and alarm emails are unchanged. **Mutation:** skip the disposition check → the partial unique index raises → FAIL. Then the pure `intakeDisposition` table, one row per cell of spec §3.6, applying its precedence (a live case first; otherwise the **strongest** cleared kind): machine vs none → open; machine vs undecided → suppress; machine vs confirmed → suppress; `known_hash` vs cleared `classifier` → open; `classifier` vs cleared `known_hash` → suppress; `known_hash` vs cleared `known_hash` → suppress; `classifier` vs cleared `classifier` **and** cleared `known_hash` → suppress (strongest wins); sighting vs none → open; sighting vs undecided → **attach**; sighting vs confirmed → suppress; sighting vs cleared → open; ⚠️ **cleared `classifier` + live undecided `known_hash`**: machine → suppress, sighting → **attach** (the live case decides, not the cleared one).
  - ⚠️ **A sighting of a key with an open machine case** (AC-C10): no new `csam_cases` or `csam_case_files` row and **no 500**; the open case's file gets `seen_by`/`seen_at`/`revealed_at`, its `priority` becomes `urgent`, and the result is `already_cased` with `attached: true`. Its decision is left to the CONFIRM route. ⚠️ **The sighting's own subject is hidden** (AC-C20): a visible comment the moderator reported, which the machine case had not seen, now has a snapshot, a `keep_hidden` decision and a target row on the existing case.
  - ⚠️ **A sighting of a key with a confirmed case** (suppress): no new case, and the sighting's subject is still hidden, snapshotted and targeted on the confirmed case (AC-C20).
  - **A sighting of a cleared key:** a **new** case opens (the old file has `cleared_at`, so the partial index allows it), confirmed in the same transaction.
  - A **mixed batch** (one suppressed key and one new key with a different uploader): only the new key is cased, and only the new uploader gets a hold.
  - **(c) moderator sighting of a fresh key:** intake calls `confirmCaseInTx` (Task 9) in its own transaction: the uploader is terminated, the report is queued with `queued_by = 'confirm'` and `viewed_by_esp = true`, the file has `seen_by` and `revealed_at`, `review_outcome = 'confirmed'`, `priority = 'decided'`, and no alarm email is sent. (Write it now as `it.todo`; Task 9 makes it real.)
  - ⚠️ **Unmatched digest** (spec §5): a known-hash intake naming one sha256 with a `media` row and one without → the case opens for the first, and one `csam_unmatched_digests` row records the second (`unmatched: 1`). An intake whose sha256s **all** match no row → `nothing_to_do: no_media_rows`, with the rows recorded.
  - **Re-upload (AC-C17):** after a known-hash intake, another user uploads the identical image: 415, nothing in `MEDIA`, one `csam_upload_attempts` row naming the case and that user, the case's `alarm_next_at` reset to now, and **no** new `ncmec_reports` row (the spec §3.7 draft default).
  - **AC-C7:** after any intake, the stubbed Postmark captured **zero** messages to the uploader or any author.
  - **Atomicity:** `hooks.beforeCommit` throws. Afterwards nothing is left behind: no case, no hold, no hidden content, no report, no unmatched-digest row, no alarm email; the error propagates; and no post-commit step ran (the object is still in `MEDIA`).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement `config.ts`** as above.
- [ ] **Step 4: Implement `intake.ts`.** It follows spec §3.3 steps 0–9, including 7, 7a and 8a, literally, in that order. The helpers it needs all exist on main or in earlier tasks: `sha256sInMarkdown`, `r2KeyForSha256`, `MEDIA_KEY_SQL_PATTERN`, `imposeLegalHold` (`legal-hold.ts:19`), `imposeAccountHoldInTx` (`account-holds.ts:49`), `applyDecisionInTx` (`decide.ts:90`), `applyAccountActionInTx` (Task 2), `recordModerationAction`, `afterContentDecision` (`after-content-decision.ts:29`), `enqueueAndAttemptMove` (`moves.ts:41`). Required SQL:
  - uploaders of keys: `SELECT DISTINCT owner_id, r2_key, sha256, min(created_at) OVER (PARTITION BY owner_id) AS first_upload FROM media WHERE r2_key = ANY($1::text[])`
  - embedding content: two scans, index-free like the reaper, each matching `regexp_matches(<column>, '${MEDIA_KEY_SQL_PATTERN}', 'g')` against the key set: `posts.markdown_source` and `comments.body_markdown`.
  - existing case files: `SELECT f.case_id, f.r2_key, f.kind, COALESCE(c.review_outcome, 'undecided') AS outcome FROM csam_case_files f JOIN csam_cases c ON c.id = f.case_id WHERE f.r2_key = ANY($1::text[])`, then `intakeDisposition` per key.
  - lock: `SELECT pg_advisory_xact_lock($1)` with `CSAM_INTAKE_LOCK_ID`, as the **first** statement after `BEGIN_BOUNDED_TX`.
  - step 6, per item in id order: `SELECT … FROM posts|comments WHERE id = $1 FOR UPDATE` (no row → skip); the snapshot `INSERT` (posts: `(post_id, author_id, title, body_markdown)`; comments: `(comment_id, author_id, body_markdown)`); `const result = await applyDecisionInTx(c, { subject, subjectId, decision: "keep_hidden", reason: CSAM_QUARANTINE_REASON, actorAdmin })`; `if (result === null) continue;` and `if (!result.wasHidden)` insert the `csam_case_targets` row. ⚠️ `CSAM_QUARANTINE_REASON` is emailed verbatim to any DSA reporter whose confirmed notice this resolves (`decide.ts:144`, `after-content-decision.ts:59-64`), so it names no hash, case or person.
  - step 7a runs only for `kind === "known_hash"`.
  - step 8: `ncmec_reports.status` is `ncmecConfig(env) === null ? 'awaiting_credentials' : 'pending'`, `queued_by = 'match'`, only when `queuesReportAtMatch(kind, reportAtMatch)`; `viewed_by_esp` from the §3.1 query (false at match).
  - step 4: `priority` = `urgent` for `known_hash`, `high` for `classifier`, `decided` for a sighting; `alarm_next_at = now()` except for a sighting (NULL).
  - a sighting whose key is attached **or** suppressed still runs `quarantineItemInTx` on its own subject with the existing case's id (spec §3.3 step 2).
  - attach (a sighting on an open case): `UPDATE csam_case_files SET seen_by = $actor, seen_at = now(), revealed_at = COALESCE(revealed_at, now()), revealed_by = COALESCE(revealed_by, $actor) WHERE case_id = $1 AND r2_key = $2` and `UPDATE csam_cases SET priority = 'urgent', alarm_next_at = now() WHERE id = $1 AND review_outcome IS NULL`.

  Post-commit, exactly as spec §3.3 says: first `enqueueAndAttemptMove(env, ctx, key, "to_restricted")` for **every matched key**; then `afterContentDecision(env, ctx, { subject, decision: "keep_hidden", reason: CSAM_QUARANTINE_REASON, result })` for each hidden item, ⚠️ **with no `legalHold`** (passing it would hold every co-embedded key, `visibility-hook.ts:34-53`); then `sendCaseAlarm(env, ctx, caseId)` from Task 8 (best effort; until Task 8 lands, a stub that the tick will cover). An epoch bump only for an uploader the bar branch terminated (never, with R1 as set).

  In `media.ts`'s Task 2a branch: when the held key's hold is `csam`, insert a `csam_upload_attempts` row for the newest case holding that key and set that case's `alarm_next_at = now()` if undecided (one statement each; never fail the refusal if they error, log it).

  The module header states: no notices (A3, R1), the R1 and "Option B" pointers, why only matched keys are held, and the "one transaction, then post-commit" rationale.
- [ ] **Step 5:** run → PASS. Run the two mutations and record the results. Commit `feat(csam): intake — quarantine matched keys, preserve, hold, open a priority case, queue known-hash reports (Part of #114)`.

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
  - `5102` on `finish` → `finished`, not an error, and no backoff.
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
    2. `pending` → build the XML from the case's data (uploader `users.email`, `profiles.username`, profile URL `https://community.thinkersjournal.com/@<handle>`, embedding URLs from a fresh scan of posts and comments for this report's keys (a comment's URL is its post's URL; `csam_case_targets` is not used, because it omits content that was already hidden), `incidentDateTime` = the uploader's earliest matched `media.created_at`). **INSERT the `ncmec_submissions` row before calling `submit`** (the bytes are preserved even if the call dies), then call it. On `ok`, set `ncmec_report_id`, `opened_at = last_modified_at = now`, `status = 'submitted'`, and backfill `ncmec_submissions.ncmec_report_id`.
    3. Each file lacking `ncmec_file_id` → `MEDIA_RESTRICTED.get(r2_key)` → `await obj.arrayBuffer()` → `upload` → store `ncmec_file_id`, touch `last_modified_at`. A missing object is a `transport_error`-style failure with `last_error = 'object missing from MEDIA_RESTRICTED: <key>'`: it retries, and it alarms through condition 3 at 6 h.
    4. Each file with `fileinfo_sent = false` → `fileinfo` (with that row's `viewed_by_esp`) → set it true.
    5. `finish` → `finished`, `finished_at`. ⚠️ `ncmec_error 5102` on `finish` ("report already finished": an earlier finish succeeded but its answer was lost) is **success**: `finished`, `finished_at = now`, `last_response_code = 5102` kept.
  - Any `ncmec_error 5001` at steps 3–5 → abandon and continue as in step 1. Any `ncmec_error 4100` → `failed`, stop this report. `ncmec_error 2000|3100` → record it, **stop the whole tick**. `transport_error` → record it and back off (`attempts++`, `next_attempt_at = now + NCMEC_BACKOFF_MINUTES[min(attempts-1, last)]` minutes). Every successful NCMEC call updates `last_modified_at`, and every outcome writes `last_response_code`/`last_error` (cleared on success).
  - Each state transition is its own short `withClient` write. **No transaction spans a network call** (`BEGIN_BOUNDED_TX`'s 10 s idle timeout would kill it).
  - In `apps/api/src/index.ts`'s `*/2 * * * *` branch (`:90-92` at `9a76b6f`), add `ctx.waitUntil(runNcmecDrain(env, ctx));` next to `runMediaBackfillBatch`.
- [ ] **Step 4:** run → PASS; run the mutation; commit `feat(csam): the NCMEC drain — resumable, window-aware, retracts on a clear, never silent about credentials (Part of #114)`.

---

### Task 8: Alarms and case escalation

**Files:** create `apps/api/src/csam/alarms.ts`; modify `apps/api/src/media/moves.ts` (export `retryHeldMoves`), `apps/api/src/index.ts` (add an explicit `if (controller.cron === "0 14 * * *")` call to the daily alarm check. Today there is no such branch, only the `disposition` ternary at `:93` before the unconditional email drain; keep that drain unchanged), `drain.ts` (immediate emails, the case tick and the log line), `apps/api/src/routes/admin-csam.ts` (`GET /admin/csam/alarm`, created here if Task 9 hasn't run yet); test `apps/api/test/csam-alarms.test.ts`.

**Produces:** `csamAlarmState(c, now): Promise<{ raised: boolean; counts: { awaitingCredentials: number; failed: number; overdueReports: number; abandonedUnfinished: number; credentialRejected: number; undecidedCases: number; overdueCases: number; unmatchedDigests: number; heldButPublic: number } }>`; `retryHeldMoves(env, ctx, moveIds: readonly string[]): Promise<{ reset: number; attempted: number }>` in `moves.ts`: for each id, if the row is `failed`, reset it to `pending` with `attempts = 0` and log `csam: reset failed move <id> for held key`; then run the private `runMove` for it, as `processPendingMoves` (`moves.ts:116-140`) does for all pending rows. (`processPendingMoves` itself never retries a `failed` row.) `sendCsamAlarmEmail(env, state): Promise<boolean>`; `sendCaseAlarm(env, ctx, caseId, now?): Promise<boolean>`; `runCaseEscalation(env, ctx, now?): Promise<{ sent: number }>`. In `config.ts`, each marked `// DRAFT DEFAULT — awaiting CireSnave's OK (board item 125), spec §6.2`:

```ts
export const CSAM_REVIEW_TARGET_HOURS = 24;
export const CSAM_ALARM_REPEAT_HOURS = 4;            // known_hash cases
export const CSAM_CLASSIFIER_ALARM_REPEAT_HOURS = 24; // classifier cases (a proposal)
export const CSAM_OVERDUE_SUBJECT_PREFIX = "OVERDUE";
export const CSAM_REPORT_OVERDUE_HOURS = 6;           // §6 condition 3 (unchanged)
```

`CSAM_ALARM_EMAIL` is a **Worker secret supplied by the operator** (`env.CSAM_ALARM_EMAIL`), never a constant. If it is missing, every alarm email is skipped with an `ncmec ALARM` log line naming the missing secret, and the banner shows it.

- [ ] **Step 1: Failing test.** One case per §6 condition (1–8), each seeding exactly that condition and asserting its count is 1 and `raised` is true. **Mutation per condition:** remove that condition's term from the query → its case FAILS (AC-C4; report all eight). Plus:
  - condition 7: an unacknowledged `csam_unmatched_digests` row raises it; acknowledging it (Task 9's route) clears it;
  - condition 8, evaluated on the **newest** `media_moves` row per key (`0016_media_visibility.sql:44-46`): a newest row `to_restricted`, `pending`, created 5 min ago, on a key with a `csam` media hold raises it; the same on an **unheld** key does not; a newest `failed` row on a held key does; a newest `done` row does not, **even with an older `failed` row for the same key** (history alone never alarms). The `*/2` tick passes the raising rows to `retryHeldMoves`: a `failed` row is reset to `pending` with `attempts = 0` and the reset is logged; after a tick in which R2 succeeds the row is `done`, the object is in `MEDIA_RESTRICTED`, and the condition clears. **Mutation:** evaluate every row instead of the newest → the "older failed, newer done" case FAILS;
  - **first raised, conditions 7 and 8:** the first tick that sees an unmatched digest (or a raising move row) emails once and writes `csam_alarm_marks (7|8, ref)`; the next tick, still raised, sends no immediate email; the daily tick does;
  - a clean state → `raised: false`, all zeros;
  - `GET /admin/csam/alarm` is Access-gated and returns the state;
  - the `0 14 * * *` tick sends exactly one report-alarm email when conditions 1–5 hold and none when clear;
  - ⚠️ **RF5:** a drain tick that **records** a `2000` sends the immediate alarm email **on that tick**, and so does one that sets `failed`. A later tick, with the condition still raised, sends **no** immediate email; the daily one covers it. Implement "first raised" as `last_response_code` changing to 2000/3100, or `status` changing to `failed`, within this tick;
  - every drain tick while raised logs one line starting with `ncmec ALARM` (spy on `console.error`);
  - ⚠️ **AC-C16, escalation**, with `now` passed explicitly: a `known_hash` case created at T sends its URGENT email at T (subject starts `URGENT`), none at T+2 min, one at T+4 h, one at T+8 h, …; at T+24 h+ the subject starts with `OVERDUE`. A `classifier` case repeats at T+24 h, not T+4 h. A decided case sends nothing. **No tick ever changes `review_outcome`, `disabled_at` or a hold**: assert all three unchanged after a run at T+72 h. **Mutation:** drop the `alarm_next_at` advance → the T+2 min tick sends a second email → FAIL;
  - the email body names the case link and the kind only: no image, sha256, handle, user id or email (assert none of the seeded values appear);
  - with `CSAM_ALARM_EMAIL` unset, no email is attempted and the log line names it.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** One SQL statement computing all nine counts. Condition 7 is `acknowledged_at IS NULL` on `csam_unmatched_digests`. Condition 8 is computed over the newest row per key, `SELECT DISTINCT ON (r2_key) id, r2_key, direction, status, created_at FROM media_moves ORDER BY r2_key, created_at DESC` (served by `media_moves_key_idx`, `0016:47`), joined to `media_legal_holds h ON h.category = 'csam'`, keeping rows with `direction = 'to_restricted' AND (status = 'failed' OR (status = 'pending' AND created_at < $now - interval '2 minutes'))`; the drain tick passes those row ids to `retryHeldMoves` before computing the state. Conditions 7 and 8 email per item on first raise: `INSERT INTO csam_alarm_marks (condition, ref) … ON CONFLICT DO NOTHING RETURNING ref`, and only the returned refs are emailed; after that, the daily tick covers them. Condition 3 is `status NOT IN ('finished','withdrawn') AND created_at < now - CSAM_REPORT_OVERDUE_HOURS` on `ncmec_reports.created_at` (the queueing time: the match for a match-time report, the CONFIRM otherwise). Condition 6 is `review_outcome IS NULL` on `csam_cases`; `overdueCases` additionally `created_at < now - CSAM_REVIEW_TARGET_HOURS`.
  `runCaseEscalation` (called from the drain tick): `UPDATE csam_cases SET alarm_next_at = $now + <repeat for kind>, alarms_sent = alarms_sent + 1, last_alarm_at = $now WHERE review_outcome IS NULL AND alarm_next_at <= $now RETURNING …`, **then** send one email per returned case (claim first, then send, so two overlapping ticks cannot double-send; a failed send resets `alarm_next_at = $now` so the next tick retries). `sendCaseAlarm` (intake's post-commit) runs the same claim for one case. Subjects: `URGENT: CSAM match needs review` (known_hash) / `CSAM review needed` (classifier), each prefixed `OVERDUE — ` past the target. The report alarm keeps its subject `"⚠ NCMEC reporting needs attention"`. All go out on the `"outbound"` stream with a link to `/admin/csam`.
- [ ] **Step 4:** run → PASS; mutations; commit `feat(csam): alarm conditions and case escalation — banner, URGENT and OVERDUE email, log line (Part of #114)`.

---

### Task 9: Admin routes — intake, list, reveal, CONFIRM, CLEAR, retry

**Files:** create or extend `apps/api/src/routes/admin-csam.ts`, `apps/api/src/csam/review.ts`; modify `apps/api/src/routes/media-restricted.ts` (log a view only after a successful `get`), `apps/api/src/routes.ts`, `pipeline-exempt.ts`, `packages/shared/src/admin.ts` (wire types); test `apps/api/test/admin-csam-route.test.ts` (the admin JWT harness, copied **by symbol** from `admin-decision-route.test.ts`: imports, `TEAM`/`AUD`/`KID`, `b64url`, `b64urlJson`, all five module-scope `let`s, `makeJwt`, `ctxRun`, `call`, and the module-level `beforeEach`/`afterEach`), and `apps/api/test/csam-review.test.ts` (pool).

**Routes:**
- `POST /admin/csam/matches` `{ lines: string[] }` → each line goes through `sha256FromMatchInput`, then `runIntake({ source: "cloudflare_match", kind: "known_hash", … })`. Returns `200 { unrecognised: { line: number; text: string }[], result: IntakeResult }`. If every line is unrecognised: `400 INVALID_INPUT` with the list. **No silent drop.**
- `POST /admin/csam/cases` `{ subject: "post" | "comment", subjectId, statement }` (`statement` non-blank: the moderator's own text, passed to `confirmCaseInTx`) → `runIntake({ source: "moderator", kind: "moderator_sighting", … })`. A blank statement → `400 INVALID_INPUT`.
- `GET /admin/csam` → undecided cases first (`urgent`, then `high`, oldest first), then the rest newest first; each with kind, source, age against `CSAM_REVIEW_TARGET_HOURS`, files (sha256, `revealed_at`, whether a logged full fetch exists, `seen_by`, `evidence_key`), reports (status, `queued_by`, `ncmec_report_id`, `last_error`, `abandoned_report_ids`), re-upload attempts, review state, and whether a runbook follow-up is due (cleared, a `finished` report, `ncmec_followup_at IS NULL`). Also the unacknowledged `csam_unmatched_digests`.
- `POST /admin/csam/files/:id/reveal` → set `revealed_at`/`revealed_by` (once), open a grant with `requestMediaAccess` (`media-access-requests.ts:15`) plus `case_file_id = :id` (one extra column in the same insert; extend the function with an optional `caseFileId`), and return `{ sha256, grantId }`. It writes **no** `media_access` row. A second admin approves the grant on the existing media-access page; the image itself goes only through `GET /media/restricted/:sha256?grantId=…` (`media-restricted.ts:81-135`).
- `POST /admin/csam/:caseId/confirm` `{ statement }` (non-blank) → `confirmCase(...)`.
- `POST /admin/csam/:caseId/clear` `{ statement }` (non-blank) → `requestClear(...)` for a `known_hash` case, `clearCase(...)` directly for a `classifier` case.
- `POST /admin/csam/:caseId/clear/approve` → `clearCase(...)`; refused `409 CSAM_SAME_HAND` when `sameAdminHand(approver, clear_requested_by)`.
- `POST /admin/csam/:caseId/ncmec-followup` → set `ncmec_followup_at`/`_by` (the runbook step was done).
- `POST /admin/csam/unmatched/:id/acknowledge` `{ note }` (non-blank) → set `acknowledged_by`/`_at`/`acknowledgement` (clears §6 condition 7 for that row).
- `POST /admin/csam/reports/:id/retry` → `failed` → `pending`, with `attempts = 0` and a log line. Any other status → `409 CSAM_NOT_RETRYABLE`.

Add `CSAM_NOT_RETRYABLE`, `CSAM_SAME_HAND`, `CSAM_ALREADY_DECIDED` and `CSAM_NOT_VIEWED` to the `ApiErrorCode` union, each with a one-line comment, the way plan A added its codes.

**The restricted route change (spec §3.1).** Today the legal-hold branch writes `media_access` (`media-restricted.ts:126-133`) **before** `serveObject` looks the object up (`:55-57`), so a 404 is logged as a view. Change that branch to: `const object = await env.MEDIA_RESTRICTED.get(r2Key); if (object === null) return notFound();` with **no** log row; then `recordModerationAction(c, { …, action: "media_access", subjectLabel: r2Key, internalNote: grantId })`; then return the response built from that same `object` (split `serveObject` into a `get` and a `respond(object)` helper; the unheld branch keeps its behaviour). Test in `media-restricted-route.test.ts`: a grant fetch of a held key whose object is missing → 404 and **no** `media_access` row; the same fetch with the object present → 200 and exactly one row whose `internal_note` is the grant id. **Mutation:** move the log back above the `get` → the first case FAILS.

**"Viewed" (spec §3.1), one query used by CONFIRM, CLEAR and report queueing**, keyed on the grant and never on a clock window: a case file `f` is viewed when `f.seen_by IS NOT NULL` or `EXISTS (SELECT 1 FROM media_access_requests r JOIN moderation_actions a ON a.action = 'media_access' AND a.subject_label = r.r2_key AND a.internal_note = r.id::text WHERE r.case_file_id = f.id)`. (The earlier "after the case's `created_at`" window was wrong: `created_at` is the intake transaction's start, not its commit.)

**Decided** means `review_outcome IS NOT NULL`, everywhere; `priority = 'decided'` mirrors it for sorting and is never tested on its own.

**`review.ts`:**
- **`confirmCaseInTx`** (spec §3.5), with exactly this signature:
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
  Transaction-neutral (no BEGIN/COMMIT/ROLLBACK/try, like `applyDecisionInTx`). Lock the case `FOR UPDATE` (no row → `not_found`); return `already_decided` when `review_outcome IS NOT NULL` and `not_viewed` (with the failing case-file ids) when a file fails the "viewed" query (a sighting's files have `seen_by`, so they pass); for each uploader, `applyAccountActionInTx(c, { kind: "terminate", reason: <fixed text>, subjectLabel: <handle>, … })` and `imposeAccountHoldInTx(c, { category: "csam", … })` (a no-op for a known-hash case that took it at match); for each uploader with no `ncmec_reports` row for this case (`ncmec_reports_one_per_uploader`), queue one (`queued_by = 'confirm'`, `viewed_by_esp` from the "viewed" query); keep every media hold; write `csam_review`; set `review_outcome = 'confirmed'`, `priority = 'decided'`, `alarm_next_at = NULL`. Returns `confirmed` with the terminated user ids and the number of reports queued.
- **`confirmCase(env, ctx, …)`**: epoch bump for every uploader, `BEGIN_BOUNDED_TX`, `confirmCaseInTx`, COMMIT (ROLLBACK quietly on a refusal or error, as plan A's wrapper does), epoch bump again. No notice (A3). Intake's sighting path calls `confirmCaseInTx` inside its own transaction (Task 6) and bumps the epochs around it.
- **`requestClear(...)`**: set `clear_requested_by`/`_at` and the statement on an undecided `known_hash` case after the same "viewed" check; nothing else changes and the alarm continues.
- **`clearCase(env, ctx, { caseId, statement, actorAdmin })`** (spec §7.2):
  1. Before the transaction: for each case file, `MEDIA_RESTRICTED.get(r2_key)` → `put` to `evidence/csam/<caseId>/<sha256>.webp` → `head` it. Any failure aborts the clear with a 503 and changes nothing (re-running is idempotent).
  2. One transaction: lock the case; refuse it when `review_outcome IS NOT NULL`; require the "viewed" check; for a `known_hash` case require `clear_requested_by` and a different hand; set `evidence_key` and `cleared_at` on each file; `imposeLegalHold` on each evidence key (category `csam`, the case's `hold_action_id`); write the `csam_clear_release` action; for each serving key, release **only the case's own hold**:
     ```sql
     WITH released AS (
       DELETE FROM media_legal_holds
        WHERE r2_key = $1 AND moderation_action_id = $2   -- $2 = the case's hold_action_id
        RETURNING r2_key, category, imposed_by, created_at, moderation_action_id)
     INSERT INTO media_legal_hold_releases
       (r2_key, category, imposed_by, imposed_at, moderation_action_id, case_id, release_action_id, released_by, requested_by)
     SELECT r2_key, category, imposed_by, created_at, moderation_action_id, $3, $4, $5, $6 FROM released
     ```
     A hold with any other `moderation_action_id` (a `dmca`/`other` hold, or an earlier case's) is untouched, and its key stays restricted. Then, for every row in `csam_case_targets` (only content that was visible at the match): ⚠️ if the target still embeds a key (`mediaKeysReferencedBy`) that has a `csam_case_files` row of **another** case with `cleared_at IS NULL` (live or confirmed), do **not** restore it, and set `restore_skipped_case_id` to that case (spec §7.2 step 3); otherwise `applyDecisionInTx(c, { subject, subjectId, decision: "restore", … })`, skipping a `null`; reports: `awaiting_credentials|pending|failed` → `withdrawn`, `submitted` → `retract_pending`, `finished` untouched; write `csam_review`; set `review_outcome = 'false_positive'`, `priority = 'decided'`, `alarm_next_at = NULL`.
  3. After commit: `afterContentDecision(env, ctx, { subject, decision: "restore", reason, result })` **without** `legalHold` for each restored item; with the hold gone, `applyMediaVisibilityChange` moves its keys back to `MEDIA` (`visibility-hook.ts:64-65`). For a released key no restored item embeds, `enqueueAndAttemptMove(env, ctx, key, "to_public")` only if `isKeyPubliclyReachable` says visible content uses it.
  The account is not touched (nothing was barred), and any `csam` account hold stays (`account-holds.ts:162`; spec §7.3).

- [ ] **Step 1: Failing tests.** Cases, each written out in full:
  - the gate (cross-site 403, no JWT 401) on each POST;
  - matches: a mixed paste returns exactly the unrecognised lines with their line numbers, and an all-garbage paste → 400 with the list;
  - list shape and order (an undecided `urgent` case above an undecided `high` one above a decided one);
  - reveal: sets `revealed_at` once, opens a grant whose `case_file_id` is the file, writes **no** `moderation_actions` row;
  - ⚠️ **viewed (AC-C19):** CONFIRM after Reveal alone → 409 `CSAM_NOT_VIEWED`. A fetch under a grant whose object is missing (404) still leaves CONFIRM at 409. A fetch through **another** grant for the same key that has no `case_file_id` does not count either. After a successful two-person fetch through the case file's own grant (`GET /media/restricted/:sha256?grantId=…`), CONFIRM proceeds, and a classifier report it queues has `viewed_by_esp = true`; a known-hash match-time report keeps `false`;
  - **CONFIRM:** every uploader is terminated (`disabled_reason = 'terminate'`) and gets 403 on login; a known-hash case gains **no** second report (its match-time one stands); a classifier case gains one report per uploader with `queued_by = 'confirm'` and its uploaders **now** have `csam` account holds (none existed before); media holds unchanged; the alarm stops; no appeal token is minted (A3), and a terminate is not appealable anyway (`routes/appeals.ts:54-60`; `moderation/appeals.ts:197-202` never lifts one);
  - `confirmCaseInTx` leaves the caller's transaction open on `already_decided` and `not_viewed` (the `SAVEPOINT` probe from Task 2);
  - **Both values of `CSAM_REPORT_AT_MATCH` at CONFIRM:** a known-hash case opened with `hooks.reportAtMatch = false` (no match-time report) gains one at CONFIRM;
  - ⚠️ **CLEAR, known-hash (AC-C15):** a clear by one admin only records the request (still undecided, still alarming); approval by the **same** admin (case-insensitive, `Alice@x` vs `alice@x`) → 409 `CSAM_SAME_HAND`; approval by a second admin → the content the case hid is publicly visible again, `env.MEDIA.get(key)` is not null, `evidence/csam/<caseId>/<sha256>.webp` exists in `MEDIA_RESTRICTED` under a `csam` hold, the serving key has no `media_legal_holds` row and one `media_legal_hold_releases` row whose `imposed_at` equals the old hold's `created_at`, the file has `cleared_at`, the uploader's account columns are unchanged and their `csam` account hold remains;
  - ⚠️ **CLEAR scope (AC-C18):** (i) a post that was already hidden before intake **stays hidden** after the clear; (ii) a key that carried a `dmca` hold **before** intake keeps it (the case's `imposeLegalHold` was a no-op), stays in `MEDIA_RESTRICTED`, and gains no release row; (iii) a hidden comment target is restored;
  - **CLEAR, report states:** a `pending` report → `withdrawn` and the NCMEC double receives **no** call; a `submitted` one → `retract_pending` (Task 7 retracts it); a `finished` one is unchanged and still listed, with "runbook follow-up due";
  - **CLEAR, classifier:** one admin suffices;
  - **CLEAR then re-detect:** the same key pasted again → `already_cased` naming the cleared case, no new case, report, hold or alarm (AC-C10, AC-C15); a moderator sighting of it **does** open a new case;
  - **Evidence copy failure:** with `MEDIA_RESTRICTED.put` stubbed to throw, the clear returns 503 and the case, holds, content and reports are unchanged;
  - a second decision on a decided case → 409 `CSAM_ALREADY_DECIDED`;
  - ⚠️ **cross-case CLEAR (AC-C20):** a post embedding key A (case 1) and key B (case 2, undecided). Clearing case 1 leaves the post hidden and sets its target's `restore_skipped_case_id` to case 2; the list shows why. Clearing case 2 afterwards restores it. **Mutation:** drop the cross-case check → the first assertion FAILS;
  - sighting route without a `statement` → 400;
  - acknowledge: clears one unmatched digest and logs who;
  - retry: only from `failed`;
  - and make Task 6's `it.todo` (moderator sighting) real.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS. **Step 5:** commit `feat(csam): admin intake, list, reveal, CONFIRM, two-person CLEAR, retry (Part of #114)`.

---

### Task 10: The admin UI

**Files:** create `apps/web/src/pages/admin/csam.astro`; modify the admin pages' shared header (or each of `admin/queue.astro`, `admin/media-access.astro`, `admin/accounts/[handle].astro`, `admin/appeals.astro`, `admin/dsa-notices.astro` if they share none) to render the alarm banner; modify `admin/queue.astro` and `admin/accounts/[handle].astro` for a "Report as CSAM" control; test `apps/web/test/admin-csam-page.test.ts`.

- The page is modelled on `admin/media-access.astro` (Access guard first, `markPrivate`, `setPublicPageCsp`). It has:
  - a textarea "Paste the matched paths from Cloudflare's email, one per line" → POST matches, showing the unrecognised lines;
  - the case list, undecided first, each with its kind (`known hash` / `classifier`), age against the 24 h target (red once OVERDUE), report status and NCMEC id once filed, and any re-upload attempts;
  - per file, a **blurred placeholder** (no `<img>` at all until revealed). A "Reveal" form POSTs reveal and then links to the two-person media-access page for that sha256. The page never embeds the image directly, and shows whether a logged full fetch exists ("viewed") separately from "revealed";
  - per undecided case, a **Confirm** form and a **Clear** form, each with a required statement. Confirm and Clear are disabled until every file shows "viewed" (served under its own grant, or a sighting). A known-hash clear shows "awaiting a second admin" with an **Approve clear** button for anyone but the requester;
  - per cleared case with a finished report, "Runbook follow-up due" and a button recording it was done;
  - per failed report, "Retry after fix";
  - a list of unacknowledged unmatched digests ("a match arrived but the file is gone"), each with an Acknowledge form and a required note.
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
  - setting and rotating the secrets: the NCMEC pair, the three required `NCMEC_REPORTER_*` values (name, email, phone), the five optional address values and `CSAM_ALARM_EMAIL`, all via `wrangler secret put`, by the operator; never pasted into a file, commit, PR or chat log;
  - what each alarm means and what to do about it.
  - ⚠️ the two-admin precondition: who the two Access admins are, and what happens with only one (no held file can be viewed, no case decided, a known-hash false positive stays quarantined).
- [ ] **XSD check:** with exttest credentials, `GET <exttest>/xsd`, saved to `docs/superpowers/specs/ncmec-ispws.xsd`. Correct `ncmec-xml.ts`'s element names and order to it (including the reporter's phone and address elements and how a name is split), update its tests, and remove the "checked in Task 11" comment.
- [ ] **`ncmec-exttest.mjs` (AC-C8):** run against `exttest.cybertip.org` with the real exttest credentials (from env, never committed). It drives a real `submit` → `upload` (a harmless test image NCMEC's docs permit for exttest; read their instructions first) → `fileinfo` → `finish` through the **production code path** (import the built client, or run the drain against a seeded case in the dev DB), and prints the NCMEC report id and the final response. The PR body pastes that output. **APP.live does not flip until it shows `finished`** (spec AC-C8).
- [ ] **Docs:** replace #122's `[[NOT YET TRUE …]]` notes that this work makes true:
  - automatic NCMEC reporting (now true: at the match for known-hash matches, at confirmation otherwise);
  - account termination for CSAM (true **on a moderator's confirmation**; per R1 a match alone quarantines the content and leaves the account active);
  - Cloudflare scanning (still bracketed until CireSnave confirms R2 coverage).
- [ ] Commit `docs(csam): runbook; XSD-verified element names; exttest end-to-end (Part of #114)`. ⚠️ Only this PR's body carries GitHub's closing keyword for the issue, and only with AC-C8's output and AC-C6's two quoted rulings in it.

### Task 12: Record the original upload's hashes (⚠️ GATED on CireSnave, board item 126)

**Do not start until CireSnave has agreed (board item 126).** The PM relays the ruling; quote it in the PR. Everything below is written so the task can proceed the moment he does, and nothing changes before then.

**Why:** exact-hash lists (MD5/SHA-1/SHA-256 of the original file) can never match our files, because `POST /media` re-encodes every upload to WebP (`media.ts`, step 7, `:176`) and discards the original (`:23`, "THE ORIGINAL IS DISCARDED — never persisted"). From now on, record the original's hashes at upload time.

**Files:** create `apps/api/migrations/0027_media_original_hashes.sql` (or the next free number); modify `apps/api/src/routes/media.ts`; test `apps/api/test/media.test.ts` (append) and `apps/api/test/media-original-hashes-schema.db.test.ts`.

- [ ] **Step 1: Failing tests.**
  - schema: `media` has nullable `original_md5`, `original_sha1`, `original_sha256` (text), each CHECKed as lowercase hex of the right length (32, 40, 64) **or NULL**; existing rows stay NULL (no backfill: the originals are gone).
  - route: an upload of a fixture JPEG stores the three hashes of the **request body bytes** (compute the expected values in the test with `node:crypto` on the same bytes), and `original_sha256` differs from the stored WebP `sha256`. A refused upload (415, 413, held key) stores nothing.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
  - Migration: `ALTER TABLE media ADD COLUMN original_md5 text CHECK (original_md5 ~ '^[0-9a-f]{32}$'), ADD COLUMN original_sha1 text CHECK (original_sha1 ~ '^[0-9a-f]{40}$'), ADD COLUMN original_sha256 text CHECK (original_sha256 ~ '^[0-9a-f]{64}$');` and a Down that drops them.
  - Route: after step 4/5's checks pass and **before** step 7's re-encode, hash the original `bytes` with `crypto.subtle.digest` for `SHA-1` and `SHA-256`, and with Workers' `MD5` support in `crypto.subtle.digest` (a Cloudflare extension; if the pinned runtime lacks it, stop and report rather than adding a dependency). Pass the three into the existing `INSERT INTO media` (`:215`).
  - The header comment states why these columns exist and that they are hashes only: the original bytes are still discarded.
- [ ] **Step 4:** run → PASS; commit `feat(media): record the original upload's MD5/SHA-1/SHA-256 for hash-list matching (Part of #114)`.

## Whole-branch checks

- [ ] `pnpm typecheck`; `pnpm -r run test` green except the four known local `media-backfill.test.ts` timeouts (same four by name); `pnpm run test:e2e` green.
- [ ] Merge conditions AC-C1…AC-C19 each named in the PR body with the test or evidence that shows it. The mutation results from Tasks 4, 6, 7 and 8 are listed.
- [ ] AC-C6: `CSAM_BAR_UNREVIEWED_MATCH = false` and `CSAM_REPORT_AT_MATCH = true`, each with CireSnave's ruling quoted verbatim above it and in the PR body.
- [ ] `git grep` the branch for anything that looks like a real contact value (an email outside `example.test`/`example.com`, a phone number, a street address). There must be none (AC-C13).
- [ ] Deploy note: the migration before the code; the operator sets `NCMEC_USERNAME`, `NCMEC_PASSWORD`, `NCMEC_BASE_URL`, the three required `NCMEC_REPORTER_*` values (name, email, phone), the five optional address values and `CSAM_ALARM_EMAIL` with `wrangler secret put` before the first deploy that drains (until then, every report alarms as `awaiting_credentials`, by design). `NCMEC_BASE_URL` points at **exttest** until AC-C8 has shown `finished`; only then does it change to production.
- [ ] The PM allocates the version number at gate time (portfolio rule); no PR here bumps it.
