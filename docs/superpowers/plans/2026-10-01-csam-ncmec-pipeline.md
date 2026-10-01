# CSAM Detection → NCMEC Reporting Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a Cloudflare hash match or a moderator's sighting enters the system, the content stops being served, its images are held, the uploader is barred (subject to R1), the evidence is preserved, and a CyberTipline report is filed automatically within about 2 minutes. Any report that doesn't reach "filed" raises an alarm.

**Architecture:** One intake transaction writes every local consequence and queues one `ncmec_reports` row per uploader. The existing `*/2 * * * *` cron drains those rows through NCMEC's ISP Web Services (submit → upload → fileinfo → finish) as a persisted state machine, resubmitting when NCMEC's deletion window has passed. Alarm conditions are computed from the same tables and surfaced in three ways: a red banner on every admin page, an email, and a log line.

**Tech Stack:** TypeScript on Cloudflare Workers (`apps/api`), Astro SSR (`apps/web`), Postgres via Hyperdrive, R2 (`MEDIA`, `MEDIA_RESTRICTED`), `fast-xml-parser` (exact pin), vitest (pool + Node projects), Postmark "outbound".

**Spec:** `docs/superpowers/specs/2026-10-01-csam-reporting-pipeline-design.md` (PR #130, approved by the PM) and its research notes, `docs/superpowers/specs/2026-10-01-ncmec-research-notes.md`. **Read both.** Every "§n" below refers to the spec.

## Preconditions (do not start Task 1 until all hold)

- Plan A (`2026-10-01-m4-2c-enforcement-ladder.md`) is **merged**. You need `applyAccountAction`, `accountBarredResponse` and the account routes.
- Plan B (`2026-10-01-m4-2c-appeals.md`) is **merged**. You need `applyDecisionInTx`, `afterContentDecision` and its `legalHold` passthrough.
- #126 is **merged** (`moderation_snapshots`, migration 0020).
- The one migration below is written `00NN`: use the next free number at execution time.

## Global Constraints

- TypeScript **6.0.3**. Errors go through `errorResponse` and the closed `ApiErrorCode` union.
- Admin routes: `checkOrigin` first (POST), then `requireAdmin`. Each new admin POST is added to `apps/api/test/helpers/pipeline-exempt.ts` with a reason.
- **No human action between intake and NCMEC `submit`** (spec §0, NCMEC's answer; AC-C2).
- **No email to the uploader or author from any CSAM path** (A3; AC-C7).
- **The exact bytes sent to NCMEC are preserved for at least a year**, append-only, with no reaper (§2258A(h); spec §5).
- XML responses: **byte cap before parse**. `fast-xml-parser` is pinned **exactly** (no `^`), and the characterisation test passes against that pin (AC-C12). Request XML is built with an escaper, never parsed.
- Secrets `NCMEC_USERNAME`, `NCMEC_PASSWORD`; var `NCMEC_BASE_URL`, with **no default**. If any is missing, the system is "not configured" and reports sit in `awaiting_credentials`, which alarms.
- `CSAM_BAR_UNREVIEWED_MATCH` is a code constant in `apps/api/src/csam/config.ts`. **The PR that sets it does not merge until it equals CireSnave's R1 ruling, quoted in the PR** (AC-C6).
- CSAM legal holds are never released by app code.
- PR bodies say **"Part of #114"**. The last PR, which carries AC-C8's exttest evidence, says "Closes #114".

## Review Focus

1. **A batch whose keys are all already cased** (a moderator pastes yesterday's email twice). There must be no new case, report, hold or logout, and the response must name the existing case (AC-C10). Pinned in Task 6.
2. **An orphan upload** (a matched image no post embeds). It must still leave the public bucket (AC-C9). Pinned in Task 6.
3. **A multi-uploader image** (dedup): each uploader's report must carry only that uploader's files (AC-C11). Pinned in Task 6.
4. **NCMEC silently deleting a half-filed report** (the drain stalls past 24 h/1 h). It must be resubmitted fresh, with the old id kept (AC-C3). Pinned in Task 7.
5. **Credentials NCMEC rejects** (`2000`/`3100`) must alarm on the very tick they occur, not 6 h later (§6 condition 5). Pinned in Task 8.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/api/src/media/key-pattern.ts` (modify) | The one media-key pattern (SQL + JS), plus `sha256FromMatchInput`. |
| `apps/api/src/media/reachability.ts`, `reap-orphan-media.ts` (modify) | Use the shared pattern; drop their private copies. |
| `apps/api/src/moderation/account-actions.ts` (modify) | Split out `applyAccountActionInTx`. |
| `apps/api/migrations/00NN_csam.sql` (create) | The `csam_hold`/`csam_review` action kinds; `csam_cases`, `csam_case_files`, `csam_case_targets`, `ncmec_reports`, `ncmec_report_files`, `ncmec_submissions`. |
| `apps/api/src/csam/config.ts` (create) | `CSAM_BAR_UNREVIEWED_MATCH`, timing constants, the ESP contact. |
| `apps/api/src/csam/ncmec-xml.ts` (create) | Build report/fileDetails XML; parse responses under a byte cap. |
| `apps/api/src/csam/ncmec-client.ts` (create) | The HTTP calls: submit, upload, fileinfo, finish, status. |
| `apps/api/src/csam/intake.ts` (create) | The intake transaction and its post-commit steps. |
| `apps/api/src/csam/drain.ts` (create) | The cron drain state machine. |
| `apps/api/src/csam/alarms.ts` (create) | Alarm conditions and the alarm email. |
| `apps/api/src/csam/review.ts` (create) | Review outcomes, false-positive reversal, retry. |
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

- [ ] **Step 4:** run the whole `account-actions.test.ts` (plan A's 9 `applyAccountAction` tests must still pass, unchanged) plus `admin-accounts-route.test.ts` → PASS.
- [ ] **Step 5:** commit `refactor(moderation): split applyAccountActionInTx for the CSAM intake transaction (Part of #114)`.

---

### Task 3: Schema

**Files:** create `apps/api/migrations/00NN_csam.sql`; modify `apps/api/src/moderation/actions.ts` (the `ModerationActionKind` union) and `apps/api/test/migrations.db.test.ts`; test `apps/api/test/csam-schema.db.test.ts`.

**Ruling recorded here (spec §5 vs §4.3):** the spec puts `request_xml` on `ncmec_reports` with UPDATE refused, but a deletion-window resubmission (§4.3) sends **new** XML for the same `ncmec_reports` row. Preserving "the exact bytes sent" therefore needs **one append-only row per submission**: `ncmec_submissions`. That's the spec's intent, made able to hold more than one send.

- [ ] **Step 1: Failing schema test** (Node project, the `test/reports-schema.db.test.ts` harness). Cases, each written out in full:
  - `moderation_actions` accepts `action = 'csam_hold'` and `'csam_review'`, and still rejects `'nonsense'`.
  - `csam_case_files.r2_key` is UNIQUE (`csam_case_files_r2_key_key`).
  - `ncmec_reports.status` accepts exactly `awaiting_credentials|pending|submitted|finished|failed`.
  - `ncmec_submissions`: UPDATE refused, DELETE of a row younger than 1 year refused, a control DELETE at 366 days allowed, TRUNCATE refused. That's the same guard shape as #126's `moderation_snapshots`; read its migration and mirror it.
  - `csam_cases.source` accepts only `cloudflare_match|moderator`; `review_outcome` accepts only `confirmed|false_positive`, and `csam_cases_review_consistent` requires `reviewed_at`/`reviewed_by` to be set exactly when `review_outcome` is.
  - none of these tables has an FK to `users`, `posts` or `media` (evidence outlives its subject; the same reasoning as 0013). Control: `reports` does.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Migration.**

```sql
-- Up Migration
--
-- #114 — the CSAM → NCMEC pipeline (spec 2026-10-01-csam-reporting-pipeline-design.md).
-- ⚠️ BARE uuids for users/posts/media everywhere: this is evidence and must
-- outlive its subjects, the same reasoning as moderation_actions (0013).
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide',
    'csam_hold','csam_review'
  ));

CREATE TABLE csam_cases (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  source           text NOT NULL CHECK (source IN ('cloudflare_match', 'moderator')),
  hold_action_id   uuid NOT NULL,          -- bare: the csam_hold moderation_actions row
  opened_by        text NOT NULL,          -- Access identity
  created_at       timestamptz NOT NULL DEFAULT now(),
  review_outcome   text CHECK (review_outcome IN ('confirmed', 'false_positive')),
  reviewed_by      text,
  reviewed_at      timestamptz,
  review_statement text,
  CONSTRAINT csam_cases_review_consistent CHECK (
    (review_outcome IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_outcome IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

-- ⚠️ UNIQUE r2_key: a key belongs to at most one case — the idempotence the
-- intake relies on (spec §3.3 step 2; AC-C10).
CREATE TABLE csam_case_files (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id       uuid NOT NULL REFERENCES csam_cases(id),
  r2_key        text NOT NULL UNIQUE,
  sha256        text NOT NULL,
  viewed_by_esp boolean NOT NULL,
  revealed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The posts this case hid, so a false-positive review can restore exactly them.
CREATE TABLE csam_case_targets (
  case_id  uuid NOT NULL REFERENCES csam_cases(id),
  post_id  uuid NOT NULL,                  -- bare
  PRIMARY KEY (case_id, post_id)
);

CREATE TABLE ncmec_reports (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id              uuid NOT NULL REFERENCES csam_cases(id),
  subject_user_id      uuid NOT NULL,      -- bare: the uploader this report is about
  status               text NOT NULL CHECK (status IN ('awaiting_credentials','pending','submitted','finished','failed')),
  ncmec_report_id      text,
  opened_at            timestamptz,        -- when the CURRENT ncmec_report_id was opened (submit)
  last_modified_at     timestamptz,        -- last successful NCMEC call on the current report
  finished_at          timestamptz,
  abandoned_report_ids text[] NOT NULL DEFAULT '{}',
  attempts             int NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  last_error           text,
  last_response_code   int,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ncmec_reports_due_idx ON ncmec_reports (next_attempt_at)
  WHERE status IN ('pending', 'submitted', 'awaiting_credentials');

CREATE TABLE ncmec_report_files (
  report_id     uuid NOT NULL REFERENCES ncmec_reports(id),
  case_file_id  uuid NOT NULL REFERENCES csam_case_files(id),
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
-- Same guard as 0020's moderation_snapshots: no UPDATE, no TRUNCATE, no DELETE
-- inside the first year. Mirror its function/trigger pair exactly, renamed
-- ncmec_submissions_guard / ncmec_submissions_no_update_or_early_delete /
-- ncmec_submissions_no_truncate, using sent_at as the age column.

-- Down Migration
DROP TABLE IF EXISTS ncmec_submissions;
DROP FUNCTION IF EXISTS ncmec_submissions_guard();
DROP TABLE IF EXISTS ncmec_report_files;
DROP TABLE IF EXISTS ncmec_reports;
DROP TABLE IF EXISTS csam_case_targets;
DROP TABLE IF EXISTS csam_case_files;
DROP TABLE IF EXISTS csam_cases;
ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_restore','content_keep_hidden','content_remove',
    'user_warn','user_suspend','user_ban','user_terminate',
    'appeal_granted','appeal_denied','media_access',
    'author_hide','author_unhide'
  ));
```

⚠️ Before writing the CHECK list, read the **latest** migration that rebuilds `moderation_actions_action_check` (0017 at the time of writing; a later one may have extended it). Your list must be that list **plus** the two new kinds, or you'll silently drop a kind.

Add `| "csam_hold" | "csam_review"` to `ModerationActionKind` (`actions.ts`) with a one-line comment each. Add up/down `tableExists` assertions for the six tables to `migrations.db.test.ts`.
- [ ] **Step 4:** run → PASS; commit `feat(db): CSAM cases, NCMEC reports and preserved submissions (Part of #114)`.

---

### Task 4: The XML layer, and the pinned parser

**Files:** modify `apps/api/package.json`; create `apps/api/src/csam/ncmec-xml.ts`, `apps/api/test/ncmec-xml.node.test.ts`, `apps/api/test/fast-xml-parser-characterisation.node.test.ts`.

**Produces:** `buildReportXml(input: ReportXmlInput): string`, `buildFileDetailsXml(input: FileDetailsInput): string`, `parseNcmecResponse(body: Uint8Array): NcmecResponse` (throws `NcmecResponseTooLarge` above `NCMEC_RESPONSE_MAX_BYTES`), `readCapped(res: Response, max: number): Promise<Uint8Array>`.

- [ ] **Step 1: The dependency.** Add `"fast-xml-parser": "<exact version apps/web pins>"` to `apps/api/package.json` dependencies, **without `^`**. It's 5.11.1 at the time of writing; read `apps/web/package.json` and use its value. Run `pnpm install`.
- [ ] **Step 2: The characterisation test (AC-C12).** Create `fast-xml-parser-characterisation.node.test.ts`. Read `docs/superpowers/specs/2026-09-08-xml-parser-decision.md` §3–§4 and encode **each** probe it ran: the external-entity file reference (must throw), nested entity expansion (must not expand, returned literally), deep nesting at 1 000 (must throw "Maximum nested tags exceeded"), a benign document (parses), and an NCMEC-shaped response (parses to the expected object). Each runs against the installed version, configured exactly as `ncmec-xml.ts` will configure it (`processEntities: false`). Its header states: **if any of these fails after a version bump, that is a STOP**, not a test to adjust (spec §4.3).
- [ ] **Step 3: Failing XML-layer test** (`ncmec-xml.node.test.ts`). Cases, each written out in full:
  - `buildReportXml` escapes `& < > " '` in every interpolated field (a screen name like `a<b&"c'`), and the output starts with `<?xml version="1.0" encoding="UTF-8"?>`.
  - it emits the incident type, the incident time (ISO-8601), the reporting person's name and email, and the reported person's `espIdentifier`, `screenName`, `profileUrl` and `email`. **No IP element appears** (we hold none; spec §4.5).
  - `buildFileDetailsXml` emits `reportId`, `fileId`, `fileViewedByEsp` (`true`/`false`), `publiclyAvailable` (`true`) and `originalFileHash` with `hashType="SHA256"`.
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
  readonly reporter: { readonly firstName: string; readonly lastName: string; readonly email: string };
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
export interface NcmecConfig { readonly baseUrl: string; readonly username: string; readonly password: string }
export function ncmecConfig(env: Env): NcmecConfig | null; // null when any of the three is missing or empty
export type NcmecCall =
  | { readonly kind: "ok"; readonly response: NcmecResponse }
  | { readonly kind: "ncmec_error"; readonly response: NcmecResponse }      // a non-zero responseCode
  | { readonly kind: "transport_error"; readonly status: number | null; readonly error: string }; // network, 5xx, cap, unparseable
export function submit(cfg: NcmecConfig, xml: string): Promise<NcmecCall>;
export function upload(cfg: NcmecConfig, reportId: string, fileName: string, body: ReadableStream | ArrayBuffer): Promise<NcmecCall>;
export function fileinfo(cfg: NcmecConfig, xml: string): Promise<NcmecCall>;
export function finish(cfg: NcmecConfig, reportId: string): Promise<NcmecCall>;
```

- [ ] **Step 1: Failing test.** Stub `fetch` (the `vi.stubGlobal` idiom from `test/moderation-notify.test.ts`), capturing method, URL, headers and body. Cases, each written out in full:
  - `ncmecConfig` → null when `NCMEC_BASE_URL`, `NCMEC_USERNAME` or `NCMEC_PASSWORD` is missing or empty; otherwise the trimmed base URL with no trailing slash.
  - `submit` POSTs `<base>/submit` with `content-type: text/xml; charset=utf-8` and `Authorization: Basic base64(user:pass)`; a `responseCode 0` body → `ok` with `reportId`.
  - `upload` POSTs `<base>/upload` as `multipart/form-data` with fields `id=<reportId>` and `file=<blob, fileName>` → `ok` with `fileId`.
  - `fileinfo` POSTs `<base>/fileinfo` with the XML. `finish` POSTs `<base>/finish` with form field `id=<reportId>`.
  - `responseCode 4100` → `ncmec_error` (carrying 4100). An HTTP 503 → `transport_error` with status 503. A thrown `fetch` → `transport_error` with status null. An oversized body → `transport_error` whose error names the cap.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** with one private `call(cfg, path, init)` that adds the Basic header and makes the request in a try/catch. A non-2xx status is a `transport_error` (the body is not parsed). Otherwise `readCapped` then `parseNcmecResponse`; `responseCode === 0` → `ok`, otherwise `ncmec_error`; any thrown error, `NcmecResponseTooLarge` included, → `transport_error`. Use `btoa(`${username}:${password}`)` for the header. Build multipart bodies with `FormData`, so the runtime sets the boundary; never set `content-type` by hand for those.
- [ ] **Step 4:** run → PASS; commit `feat(csam): NCMEC ISP Web Services client (Part of #114)`.

---

### Task 6: Intake

**Files:** create `apps/api/src/csam/config.ts`, `apps/api/src/csam/intake.ts`; test `apps/api/test/csam-intake.test.ts` (pool).

**Produces:**
```ts
// config.ts
export const CSAM_BAR_UNREVIEWED_MATCH: boolean; // R1 — see the comment in the file
export const CSAM_INTAKE_LOCK_ID = 114_000_001;   // pg_advisory_xact_lock key
export const NCMEC_ESP_CONTACT: { firstName: string; lastName: string; email: string }; // from CireSnave
// intake.ts
export type IntakeInput =
  | { readonly source: "cloudflare_match"; readonly sha256s: readonly string[]; readonly actorAdmin: string }
  | { readonly source: "moderator"; readonly subject: "post"; readonly subjectId: string; readonly actorAdmin: string };
export type IntakeResult =
  | { readonly kind: "opened"; readonly caseId: string; readonly reports: number; readonly hiddenPosts: number; readonly barred: number }
  | { readonly kind: "already_cased"; readonly caseIds: readonly string[] }
  | { readonly kind: "nothing_to_do"; readonly reason: "no_media_rows" | "post_has_no_media" | "post_not_found" };
export function runIntake(env: Env, ctx: ExecutionContext, input: IntakeInput, hooks?: { readonly beforeCommit?: (c: Client) => Promise<void> }): Promise<IntakeResult>;
```

**R1 placeholder rule:** until CireSnave rules, `config.ts` sets `CSAM_BAR_UNREVIEWED_MATCH = true` with the comment `// R1 PENDING — CireSnave's ruling must be quoted here before this PR merges (spec §3.4, AC-C6).` A test pins **both** branches by calling an internal `whoIsBarred(source, flag)` with the flag passed explicitly, so flipping the constant needs no test change.

**Comment-media note:** comments carry no media today (only `posts.markdown_source` is scanned by the reaper). Intake therefore resolves embedding **posts** only, and (b) accepts `subject: "post"` only. Say so in `intake.ts`'s header.

- [ ] **Step 1: Failing test.** Fixtures: seed `media` rows (owner, `r2_key`, sha256), put objects in `env.MEDIA`, and seed posts whose markdown embeds them, reusing `reap-orphan-media.test.ts`'s `seedMedia`/`insertPost` idiom. Stub `env.WEB` for the cache purge as `admin-decision-route.test.ts` does. Cases, each written out in full:
  - **(a) match, single uploader, embedded once:** `opened`. Then the post 404s through the **public** read route (AC-C1); the key is in `media_legal_holds` with `category = 'csam'` and `moderation_action_id` = the case's `hold_action_id`; `env.MEDIA.get(key)` is null and `env.MEDIA_RESTRICTED.get(key)` is not (AC-C1, AC-C9); a `moderation_snapshots` row exists for the post; the uploader's `disabled_reason = 'terminate'`; one `ncmec_reports` row is `pending`, or `awaiting_credentials` when the test env lacks NCMEC vars (assert whichever the env implies); one `ncmec_report_files` row; `csam_case_files.viewed_by_esp = false`.
  - ⚠️ **RF2 / AC-C9, an orphan upload** (no post embeds the key): the object still leaves `MEDIA` for `MEDIA_RESTRICTED`, and the hold exists. **Mutation:** drop the orphan-move call → FAIL.
  - ⚠️ **RF3 / AC-C11, a multi-uploader key plus a second key only one of them uploaded:** two reports. Uploader A's report carries both files; B's report carries only the shared one.
  - ⚠️ **RF1 / AC-C10:** run the same intake twice. The second returns `already_cased` naming the first case; the counts of `csam_cases`, `ncmec_reports`, holds and `moderation_actions` are unchanged; and **the uploader's epoch did not move** on the second call (`getEpoch` before and after). **Mutation:** remove step 2's filter → FAIL.
  - A **mixed batch** (one already-cased key and one new key with a different uploader): only the new key is cased, and only the new uploader's epoch moves.
  - **(b) moderator, post:** `viewed_by_esp = true`, and the uploader is barred regardless of the flag.
  - **R1 both branches:** `whoIsBarred("cloudflare_match", false)` bars nobody; `whoIsBarred("cloudflare_match", true)` and `whoIsBarred("moderator", false)` bar all uploaders. An intake run with the constant **as set** matches the corresponding branch.
  - **AC-C7:** after any intake, the stubbed Postmark captured **zero** messages.
  - **Atomicity:** `runIntake` takes an optional 4th parameter `hooks?: { readonly beforeCommit?: (c: Client) => Promise<void> }`, called immediately before COMMIT. It's used only by tests, and the header says so. A test passes a `beforeCommit` that throws. Afterwards nothing is left behind: no case, no hold, no hidden post, no bar, no report; the error propagates; and no post-commit step ran (the object is still in `MEDIA`).
  - **Unrecognised input:** the route test (Task 9) covers the line-by-line rejection. Here, an intake whose sha256s match no `media` row returns `nothing_to_do: no_media_rows`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement `config.ts`** as specified above. For `NCMEC_ESP_CONTACT`, use the values CireSnave supplies. Until then use `{ firstName: "[[ESP_CONTACT_FIRST]]", lastName: "[[ESP_CONTACT_LAST]]", email: "[[ESP_CONTACT_EMAIL]]" }`, and add a test asserting that `NCMEC_ESP_CONTACT` contains no `[[`. **That test is `it.skip`-free and fails until the real values land, by design: the PR cannot merge without them.** Name it `"the ESP contact is real (merge condition)"`.
- [ ] **Step 4: Implement `intake.ts`.** It follows spec §3.3 steps 0–9 **literally, in that order**. The helpers it needs are all already defined: `sha256sInMarkdown`, `r2KeyForSha256`, `MEDIA_KEY_SQL_PATTERN`, `imposeLegalHold`, `applyDecisionInTx`, `applyAccountActionInTx`, `recordModerationAction`, `afterContentDecision`, `enqueueAndAttemptMove`, and `env.USER_SECURITY.getByName(id).bumpEpoch()`. Required SQL:
  - uploaders of keys: `SELECT DISTINCT owner_id, r2_key, sha256, min(created_at) OVER (PARTITION BY owner_id) AS first_upload FROM media WHERE r2_key = ANY($1::text[])`
  - embedding posts: `SELECT id, author_id, title, markdown_source FROM posts WHERE markdown_source ~ ANY($1::text[])`, with `$1` = one escaped regex per sha256 (`'media/post/' || sha || '\.webp'`). Or, simpler and index-free like the reaper, a scan matching `regexp_matches(markdown_source, '${MEDIA_KEY_SQL_PATTERN}', 'g')` against the key set.
  - already cased: `SELECT case_id, r2_key FROM csam_case_files WHERE r2_key = ANY($1::text[])`.
  - lock: `SELECT pg_advisory_xact_lock($1)` with `CSAM_INTAKE_LOCK_ID`, as the **first** statement after `BEGIN_BOUNDED_TX`.
  - the snapshot (step 6): `INSERT INTO moderation_snapshots (post_id, author_id, title, body_markdown) VALUES (…)` from the locked post row (`SELECT … FOR UPDATE`).
  - `csam_case_targets` gets one row per hidden post.
  - `ncmec_reports.status` is `ncmecConfig(env) === null ? 'awaiting_credentials' : 'pending'`.

  Post-commit, exactly as spec §3.3 says: `afterContentDecision(env, ctx, { subject: "post", result, legalHold: { category: "csam", moderationActionId: holdActionId, imposedBy: actorAdmin } })` for each hidden post (⚠️ the `legalHold` object is **required**: without it the image stays public, and the AC-C9 mutation proves it); `enqueueAndAttemptMove(env, ctx, key, "to_restricted")` for each orphan key; then the second epoch bump for every barred uploader. The pre-transaction bump (step 0) uses the **filtered** key set.
  The whole module carries the header comment set from the spec: its own A3 note (no notices), the R1 pointer, and the "one transaction, then post-commit" rationale.
- [ ] **Step 5:** run → PASS (the "ESP contact is real" test stays red until CireSnave's values land; the report says so explicitly). Run the two mutations and record the results. Commit `feat(csam): intake — one transaction holds, hides, preserves, bars and queues the report (Part of #114)`.

---

### Task 7: The drain

**Files:** create `apps/api/src/csam/drain.ts`; modify `apps/api/src/index.ts` (the `*/2` branch); test `apps/api/test/csam-drain.test.ts` (pool, NCMEC test double via a `fetch` stub that routes on URL path).

**Produces:** `runNcmecDrain(env, ctx, now?: Date): Promise<{ processed: number; finished: number }>`; constants in `config.ts`: `NCMEC_BACKOFF_MINUTES = [2, 4, 8, 16, 30]`, `NCMEC_DRAIN_BATCH = 10`.

- [ ] **Step 1: Failing test.** The double keeps per-test state (issued report ids, uploaded files, finished set) and can be scripted to fail a given call with a given code or HTTP status. Seed reports by running Task 6's `runIntake`, with `NCMEC_*` set in the test env (`env` spread with the three vars). Cases, each written out in full:
  - ⚠️ **AC-C2:** one `runNcmecDrain` takes a `pending` report to `finished`, with no other call in between: submit → upload (per file) → fileinfo (per file) → finish, in that order. One `ncmec_submissions` row exists with the exact XML the double received (byte-equal); `ncmec_report_id`, `opened_at` and `finished_at` are set; each `ncmec_report_files` row has its `ncmec_file_id` and `fileinfo_sent = true`. The upload body equals the R2 object's bytes from `MEDIA_RESTRICTED`.
  - **Resume:** the double fails `fileinfo` once (HTTP 503). After drain 1, the status is still `submitted`, `attempts = 1`, `next_attempt_at` is about 2 min ahead, and the files are uploaded. Drain 2 (with `now` advanced past `next_attempt_at`) does **not** re-upload: zero upload calls, then fileinfo and finish → `finished`.
  - ⚠️ **RF4 / AC-C3 (deletion window):** a `submitted` report whose `opened_at` is 25 h ago and `last_modified_at` 2 h ago. The drain moves its id into `abandoned_report_ids`, clears the `ncmec_file_id`s, submits fresh (a **new** id, a **second** `ncmec_submissions` row) and finishes. The same happens for a double answering `5001` to `finish`. **Mutation:** remove the window check → FAIL.
  - `4100` on submit → `failed`, `last_response_code = 4100`, `last_error` carries the description, and **the next drain does not touch it**.
  - `2000` on submit → status unchanged (`pending`), `last_response_code = 2000`, and no further calls that tick for **any** report (credentials are shared).
  - `awaiting_credentials` rows are promoted to `pending` on a tick where `ncmecConfig(env)` is non-null, and left alone when it's null.
  - Not yet due (`next_attempt_at` in the future) → untouched.
  - The `*/2` cron routes to `runNcmecDrain`: drive `scheduled` with that cron, as `reap-orphan-media.test.ts` drives its cron.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement `drain.ts`.**
  - Select due rows: `SELECT … FROM ncmec_reports WHERE status IN ('pending','submitted') AND next_attempt_at <= $now ORDER BY next_attempt_at LIMIT NCMEC_DRAIN_BATCH`, then process each **sequentially**.
  - For each report, inside one invocation:
    1. **Window check** (`submitted` only): `now > max(opened_at + 24 h, last_modified_at + 1 h)` → abandon (append the id, clear file ids and `fileinfo_sent`, set `pending`).
    2. `pending` → build the XML from the case's data (uploader `users.email`, `profiles.username`, profile URL `https://community.thinkersjournal.com/@<handle>`, embedding post URLs from `csam_case_targets` joined to posts and profiles, `incidentDateTime` = the uploader's earliest matched `media.created_at`). **INSERT the `ncmec_submissions` row before calling `submit`** (the bytes are preserved even if the call dies), then call it. On `ok`, set `ncmec_report_id`, `opened_at = last_modified_at = now`, `status = 'submitted'`, and backfill `ncmec_submissions.ncmec_report_id`.
    3. Each file lacking `ncmec_file_id` → `MEDIA_RESTRICTED.get(r2_key)` → `upload` → store `ncmec_file_id`, touch `last_modified_at`. A missing object is a `transport_error`-style failure with `last_error = 'object missing from MEDIA_RESTRICTED: <key>'`: it retries, and it alarms through condition 3 at 6 h.
    4. Each file with `fileinfo_sent = false` → `fileinfo` → set it true.
    5. `finish` → `finished`, `finished_at`.
  - Any `ncmec_error 5001` at steps 3–5 → abandon and continue as in step 1. Any `ncmec_error 4100` → `failed`, stop this report. `ncmec_error 2000|3100` → record it, **stop the whole tick**. `transport_error` → record it and back off (`attempts++`, `next_attempt_at = now + NCMEC_BACKOFF_MINUTES[min(attempts-1, last)]` minutes). Every successful NCMEC call updates `last_modified_at`, and every outcome writes `last_response_code`/`last_error` (cleared on success).
  - Each state transition is its own short `withClient` write. **No transaction spans a network call** (`BEGIN_BOUNDED_TX`'s 10 s idle timeout would kill it).
  - In `apps/api/src/index.ts`'s `*/2 * * * *` branch, add `ctx.waitUntil(runNcmecDrain(env, ctx));` next to `runMediaBackfillBatch`.
- [ ] **Step 4:** run → PASS; run the mutation; commit `feat(csam): the NCMEC drain — resumable, window-aware, never silent about credentials (Part of #114)`.

---

### Task 8: Alarms

**Files:** create `apps/api/src/csam/alarms.ts`; modify `apps/api/src/index.ts` (add an explicit `if (controller.cron === "0 14 * * *")` call to the alarm check. Today there is no such branch, only the `disposition` ternary before the unconditional email drain; keep that drain unchanged), `drain.ts` (immediate emails and the log line), `apps/api/src/routes/admin-csam.ts` (`GET /admin/csam/alarm`, created here if Task 9 hasn't run yet); test `apps/api/test/csam-alarms.test.ts`.

**Produces:** `csamAlarmState(c, now): Promise<{ raised: boolean; counts: { awaitingCredentials: number; failed: number; overdue: number; abandonedUnfinished: number; credentialRejected: number } }>`; `sendCsamAlarmEmail(env, state): Promise<boolean>`; `CSAM_ALARM_EMAIL` and `CSAM_OVERDUE_HOURS = 6` in `config.ts`.

- [ ] **Step 1: Failing test.** One case per §6 condition (1–5), each seeding exactly that condition and asserting its count is 1 and `raised` is true. **Mutation per condition:** remove that condition's term from the query → its case FAILS (AC-C4; report all five). Plus:
  - a clean state → `raised: false`, all zeros;
  - `GET /admin/csam/alarm` is Access-gated and returns the state;
  - the `0 14 * * *` tick sends exactly one alarm email when raised and none when clear;
  - ⚠️ **RF5:** a drain tick that **records** a `2000` sends the immediate alarm email **on that tick**, and so does one that sets `failed`. A later tick, with the condition still raised, sends **no** immediate email; the daily one covers it. Implement the "first raised" test as `last_response_code` changing to 2000/3100, or `status` changing to `failed`, within this tick;
  - every drain tick while raised logs one line starting with `ncmec ALARM` (spy on `console.error`).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** One SQL statement computing all five counts. Condition 3 is `status <> 'finished' AND created_at < now - 6 h`, measured from the **case's** `created_at` via a join. The email goes out on the `"outbound"` stream to `CSAM_ALARM_EMAIL`, subject `"⚠ NCMEC reporting needs attention"`, with the counts and a link to `/admin/csam`. `CSAM_ALARM_EMAIL` uses the same `[[…]]` placeholder plus "is real (merge condition)" test pattern as `NCMEC_ESP_CONTACT`.
- [ ] **Step 4:** run → PASS; mutations; commit `feat(csam): five alarm conditions — banner data, daily and immediate email, log line (Part of #114)`.

---

### Task 9: Admin routes — intake, list, reveal, review, retry

**Files:** create or extend `apps/api/src/routes/admin-csam.ts`, `apps/api/src/csam/review.ts`; modify `apps/api/src/routes.ts`, `pipeline-exempt.ts`, `packages/shared/src/admin.ts` (wire types); test `apps/api/test/admin-csam-route.test.ts` (the admin JWT harness, copied **by symbol** from `admin-decision-route.test.ts`: imports, `TEAM`/`AUD`/`KID`, `b64url`, `b64urlJson`, all five module-scope `let`s, `makeJwt`, `ctxRun`, `call`, and the module-level `beforeEach`/`afterEach`).

**Routes:**
- `POST /admin/csam/matches` `{ lines: string[] }` → each line goes through `sha256FromMatchInput`. (The spec §3.1(a) calls this field `paths`. It's `lines` here because an entry may also be a bare digest. One name, used everywhere in this plan.) Returns `200 { unrecognised: { line: number; text: string }[], result: IntakeResult }`. If every line is unrecognised: `400 INVALID_INPUT` with the list. **No silent drop.**
- `POST /admin/csam/cases` `{ subject: "post", subjectId }` → `runIntake({ source: "moderator", … })`.
- `GET /admin/csam` → cases newest first, each with files (sha256, `viewed_by_esp`, `revealed_at`), reports (status, `ncmec_report_id`, `last_error`, `abandoned_report_ids`) and review state.
- `POST /admin/csam/files/:id/reveal` → set `revealed_at` (once), log a `media_access` action naming the case, and return `{ sha256 }`. The image itself still goes only through `GET /media/restricted/:sha256` and #61's two-person grant (spec §7). Reveal records intent and does not bypass that.
- `POST /admin/csam/:caseId/review` `{ outcome: "confirmed" | "false_positive", statement }` (non-blank) → `reviewCase(...)`.
- `POST /admin/csam/reports/:id/retry` → `failed` → `pending`, with `attempts = 0` and a log line. Any other status → `409 CSAM_NOT_RETRYABLE`, a new `ApiErrorCode` added with a one-line comment, the way plan A added its codes.

**`review.ts` → `reviewCase(env, ctx, { caseId, outcome, statement, actorAdmin })`:** in one transaction, set the review columns (refusing if already reviewed → `already_reviewed`) and write a `csam_review` action. **On `false_positive`:**
- restore every post in `csam_case_targets` with `applyDecisionInTx(c, { decision: "restore", … })`;
- for each report's `subject_user_id` whose `disabled_reason = 'terminate'` **and** who has no other case that is unreviewed or `confirmed`, clear `disabled_at`/`disabled_reason`.

After commit, call `afterContentDecision` (**without** `legalHold`) for each restored post. The images stay held (spec §7); that's intended, and a test asserts the held object is **still** in `MEDIA_RESTRICTED`.

- [ ] **Step 1: Failing route test.** Cases, each written out in full:
  - the gate (cross-site 403, no JWT 401) on each POST;
  - matches: a mixed paste returns exactly the unrecognised lines with their line numbers, and an all-garbage paste → 400 with the list;
  - list shape;
  - reveal: logs `media_access` once, and is idempotent for `revealed_at`;
  - review `confirmed` changes nothing else;
  - review `false_positive`: the posts are publicly visible again, the uploader can log in again (200), the hold remains, and the object stays in `MEDIA_RESTRICTED`;
  - a second uploader with **another** confirmed case stays barred;
  - a second review → 409;
  - retry: only from `failed`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS. **Step 5:** commit `feat(csam): admin intake, list, reveal, review with false-positive reversal, retry (Part of #114)`.

---

### Task 10: The admin UI

**Files:** create `apps/web/src/pages/admin/csam.astro`; modify the admin pages' shared header (or each of `admin/queue.astro`, `admin/media-access.astro`, `admin/accounts/[handle].astro`, `admin/appeals.astro`, `admin/dsa-notices.astro` if they share none) to render the alarm banner; modify `admin/queue.astro` and `admin/accounts/[handle].astro` for a "Report as CSAM" control; test `apps/web/test/admin-csam-page.test.ts`.

- The page is modelled on `admin/media-access.astro` (Access guard first, `markPrivate`, `setPublicPageCsp`). It has:
  - a textarea "Paste the matched paths from Cloudflare's email, one per line" → POST matches, showing the unrecognised lines;
  - the case list with report status, and an NCMEC id once filed;
  - per file, a **blurred placeholder** (no `<img>` at all until revealed). A "Reveal" form POSTs reveal and then links to the two-person media-access page for that sha256. The page never embeds the image directly;
  - per case, a review form (outcome + required statement);
  - per failed report, "Retry after fix".
- **Banner:** every admin page fetches `GET /admin/csam/alarm` after its guard and, when `raised`, renders a red `role="alert"` banner with the counts, linking to `/admin/csam`.
- "Report as CSAM" on a queue item or the account page POSTs `/admin/csam/cases` for that post after a confirm checkbox.
- [ ] **Step 1: Failing source pins:**
  - the guard is the first statement on `csam.astro`;
  - `csam.astro` contains **no `<img`**;
  - every admin page includes the banner fetch;
  - the queue's CSAM control is a separate form, not a button on the decision form (spec decision #3's spirit: no accidental CSAM filing from the decide buttons).
- [ ] **Step 2:** implement; run → PASS; `pnpm typecheck`; commit `feat(web): CSAM admin page, alarm banner on every admin page (Part of #114)`.

---

### Task 11: Runbook, XSD check, and the exttest run

**Files:** create `docs/runbooks/csam.md`, `apps/api/scripts/ncmec-exttest.mjs`; modify `apps/api/src/csam/ncmec-xml.ts` if the XSD disagrees; docs (`docs/legal/community-guidelines.md` §1.2 status note, `docs/legal/privacy-policy.md` §4 note).

- [ ] **Runbook** `docs/runbooks/csam.md`, one section each:
  - reading Cloudflare's daily email and pasting it;
  - lifting Cloudflare's own block (Security Center → Blocked Content; dashboard only);
  - a false positive (review in-app, then contact NCMEC about the filed report);
  - a law-enforcement **destruction** request (§2258B(c)): who, the two-person rule, deleting the R2 object and its `csam_case_files` row by hand, and recording it;
  - rotating the NCMEC credentials;
  - what each alarm means and what to do about it.
- [ ] **XSD check:** with exttest credentials, `GET <exttest>/xsd`, saved to `docs/superpowers/specs/ncmec-ispws.xsd`. Correct `ncmec-xml.ts`'s element names and order to it, update its tests, and remove the "checked in Task 11" comment.
- [ ] **`ncmec-exttest.mjs` (AC-C8):** run against `exttest.cybertip.org` with the real exttest credentials (from env, never committed). It drives a real `submit` → `upload` (a harmless test image NCMEC's docs permit for exttest; read their instructions first) → `fileinfo` → `finish` through the **production code path** (import the built client, or run the drain against a seeded case in the dev DB), and prints the NCMEC report id and the final response. The PR body pastes that output. **APP.live does not flip until it shows `finished`** (spec AC-C8).
- [ ] **Docs:** replace #122's `[[NOT YET TRUE …]]` notes that this work makes true:
  - automatic NCMEC reporting (now true);
  - account termination for CSAM (true per R1);
  - Cloudflare scanning (still bracketed until CireSnave confirms R2 coverage).
- [ ] Commit `docs(csam): runbook; XSD-verified element names; exttest end-to-end (Closes #114)`. ⚠️ Only this PR closes #114, and only with AC-C8's output and AC-C6's quoted R1 ruling in its body.

## Whole-branch checks

- [ ] `pnpm typecheck`; `pnpm -r run test` green except the four known local `media-backfill.test.ts` timeouts (same four by name); `pnpm run test:e2e` green.
- [ ] Merge conditions AC-C1…AC-C12 each named in the PR body with the test or evidence that shows it. The mutation results from Tasks 4, 6, 7 and 8 are listed.
- [ ] The two "is real (merge condition)" tests (ESP contact, alarm email) pass, i.e. CireSnave's values have landed; and `CSAM_BAR_UNREVIEWED_MATCH` carries his quoted R1 ruling.
- [ ] Deploy note: the migration before the code; the three NCMEC secrets/vars are set with `wrangler secret put` before the first deploy that drains (until then, every case alarms as `awaiting_credentials`, by design).
