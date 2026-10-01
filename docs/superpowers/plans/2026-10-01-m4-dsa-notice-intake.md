# M4 (plan C) — DSA Notice-and-Action Intake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone, with or without an account, can file a notice that a post or comment is illegal. They confirm it from their email inbox. A moderator then rules on it with the existing decision tools, and the reporter is told the outcome. **A notice never hides anything by itself (AC-1).**

**Architecture:** A separate `dsa_notices` table (spec §3.3), never the `reports` table, because auto-hide counts distinct *member* reporters in `reports`, and a throwaway-email notice must not move that count. Intake is an unauthenticated POST guarded by Origin, a new `DSA_LIMITER`, and Turnstile. The confirmation link is peek-on-GET / confirm-on-POST. Confirmed notices appear in their **own admin list** (PM ruling; `queue.ts` stays untouched). Their decisions go through the **existing** `POST /admin/decision`, which also resolves every open notice on that target inside the decision's own transaction and emails each reporter a statement of reasons. Unconfirmed notices are reaped by the daily reaper cron.

**Tech Stack:** TypeScript on Cloudflare Workers (`apps/api`), Astro SSR (`apps/web`), Postgres via Hyperdrive, vitest (pool + Node `*.db.test.ts`), Postmark "outbound", Cloudflare Turnstile, Workers rate-limit bindings.

**Spec:** `docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md`: §3.3 (`dsa_notices`), §8 (intake flow, **AC-1**), §12 (AC-1 as a binding merge condition). Decision #6: "DSA unauthenticated notices are accepted, with the reporter's email validated."

**Rulings (PM, 2026-10-01):** DSA notices get their **own admin list** (like media-access), and decisions **reuse `POST /admin/decision`**. `queue.ts` stays untouched. AC-1 is therefore structural (a separate table, never counted), and a test still has to prove it.

**Independent of plans A and B** at the code level. It touches `decide.ts` inside the decision transaction. If plan B has merged first, put this plan's addition inside `applyDecisionInTx` (immediately after its `recordModerationAction` call). If not, put it inside `applyDecision`'s transaction, at the same point. Either way it runs in the same transaction as the decision.

## Global Constraints

- TypeScript **6.0.3**; errors via `errorResponse` and the closed `ApiErrorCode` union. This plan reuses `INVALID_INPUT`, `INVALID_JSON`, `INVALID_TOKEN`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED` and adds none.
- New rate-limit binding `DSA_LIMITER` in `apps/api/wrangler.jsonc`'s **plural** `ratelimits` array (`namespace_id` "1012", `simple: { limit: 5, period: 60 }`), and **hand-added** to `apps/api/src/worker-configuration.d.ts` as `DSA_LIMITER: RateLimit;`, with the same comment pattern as `RESET_LIMITER`/`SEARCH_LIMITER`. Do **not** rerun `wrangler types` (that file explains why).
- Unauthenticated POSTs: inline `checkOrigin` first. Add them to `apps/api/test/helpers/pipeline-exempt.ts` with a reason.
- **AC-1 (binding merge condition):** a DSA notice **never** counts toward auto-hide. Nothing in this plan may call `maybeAutoHide` or write `reports`/`hidden_at`. The AC-1 test (Task 3) must be shown to **fail** against an implementation that counts notices.
- Confirmation tokens: 32 CSPRNG bytes, base64url, stored only as `sha256Hex` (`apps/api/src/auth/encoding.ts`). **GET never confirms**; only a POST does.
- Public target only: a notice may name only a post or comment that a logged-out visitor can see (`posts.status = 'published' AND posts.hidden_at IS NULL`, and for a comment also `comments.hidden_at IS NULL AND comments.deleted_at IS NULL`). Anything else returns the same `404 NOT_FOUND` as a nonexistent id, so the form is not an existence oracle.
- The reporter's email is shown to moderators (needed to send the statement of reasons) and **never** to the content's author.
- PR body: **"Part of #113"** while plans A/B are unmerged. Use "Closes #113" only in the PR that lands the last of A/B/C.
- Migration number: the next free one at execution time.

## Review Focus

1. **Three throwaway addresses** confirming notices on one post. The post must stay visible (AC-1). Pinned in Task 3, with a mutation.
2. **A link scanner opening the confirmation email** (any number of GETs). The notice must stay unconfirmed until the explicit POST. Pinned in Task 3.
3. **A notice naming hidden, draft or nonexistent content.** It must get the identical 404, with no row written and no email sent. Pinned in Task 2.
4. **A decision on content that has confirmed notices** must resolve all of them in the same transaction and tell each reporter, while unconfirmed notices stay untouched and unresolved. Pinned in Task 4.
5. **An unconfirmed notice older than 7 days** must be reaped; a confirmed one never. Pinned in Task 3.

---

### Task 1: The schema

**Files:** create `apps/api/migrations/00NN_dsa_notices.sql`; modify `apps/api/test/migrations.db.test.ts`; test `apps/api/test/dsa-notices-schema.db.test.ts`.

- [ ] **Step 1: Failing schema test** (Node project, direct `pg`, same harness as `test/moderation-snapshots-schema.db.test.ts`). Cases, each written out in full:
  - a row with **both** `post_id` and `comment_id`, or **neither**, is rejected by `dsa_notices_one_target`;
  - `reason` outside `REPORT_REASONS` is rejected by `dsa_notices_reason_check`;
  - a blank `statement` or blank `reporter_name` is rejected by `dsa_notices_statement_check` / `dsa_notices_reporter_name_check`;
  - `good_faith = false` is rejected by `dsa_notices_good_faith_check`;
  - deleting the post deletes its notices (`ON DELETE CASCADE`). Control: a notice on a **different** post survives.
- [ ] **Step 2:** run it → FAIL (relation does not exist).
- [ ] **Step 3: The migration**

```sql
-- Up Migration
--
-- DSA notice-and-action intake (spec §3.3, §8; decision #6). A SEPARATE table
-- from `reports`, deliberately: reports.reporter_id is a NOT NULL member FK and
-- auto-hide counts DISTINCT member reporters from it. ⚠️ AC-1: nothing reads
-- this table when deciding auto-hide, and nothing must ever start to.
--
-- Two fields beyond spec §3.3, because DSA Art. 16(2) requires a notice to
-- carry them: the reporter's NAME (16(2)(c)) and a statement of good faith
-- (16(2)(d)). The URL (16(2)(b)) is the target id; the explanation (16(2)(a))
-- is `statement`.
CREATE TABLE dsa_notices (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  reporter_email       citext NOT NULL,
  reporter_name        text NOT NULL,
  good_faith           boolean NOT NULL,
  email_verified_at    timestamptz,          -- NULL = unconfirmed: INERT until set
  verify_token_hash    text NOT NULL UNIQUE, -- SHA-256 of the emailed token; never the token
  post_id              uuid REFERENCES posts(id)    ON DELETE CASCADE,
  comment_id           uuid REFERENCES comments(id) ON DELETE CASCADE,
  reason               text NOT NULL,
  statement            text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  resolution_action_id uuid,                 -- bare: the content_* decision that resolved it
  CONSTRAINT dsa_notices_one_target CHECK ((post_id IS NULL) <> (comment_id IS NULL)),
  CONSTRAINT dsa_notices_reason_check CHECK (reason IN
    ('spam','harassment','hate','sexual','violence','ip_infringement','other')),
  CONSTRAINT dsa_notices_statement_check CHECK (length(btrim(statement)) > 0 AND length(statement) <= 5000),
  CONSTRAINT dsa_notices_reporter_name_check CHECK (length(btrim(reporter_name)) > 0 AND length(reporter_name) <= 200),
  CONSTRAINT dsa_notices_good_faith_check CHECK (good_faith)
);
CREATE INDEX dsa_notices_open_idx ON dsa_notices (created_at)
  WHERE email_verified_at IS NOT NULL AND resolved_at IS NULL;
CREATE INDEX dsa_notices_post_idx ON dsa_notices (post_id) WHERE post_id IS NOT NULL;
CREATE INDEX dsa_notices_comment_idx ON dsa_notices (comment_id) WHERE comment_id IS NOT NULL;
-- The reaper's predicate.
CREATE INDEX dsa_notices_unconfirmed_idx ON dsa_notices (created_at) WHERE email_verified_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS dsa_notices;
```

Add `tableExists(client, "dsa_notices")` up/down assertions to `migrations.db.test.ts`, as plan B did.
- [ ] **Step 4:** run both → PASS; commit `feat(db): dsa_notices (Part of #113)`.

---

### Task 2: Intake — `POST /dsa-notice`

**Files:** modify `packages/shared/src/moderation.ts`, `apps/api/wrangler.jsonc`, `apps/api/src/worker-configuration.d.ts`, `apps/api/src/routes.ts`, `apps/api/test/helpers/pipeline-exempt.ts`; create `apps/api/src/routes/dsa-notice.ts`, `apps/api/src/moderation/dsa-notices.ts`; test `apps/api/test/dsa-notice-route.test.ts`.

**Interfaces:** Produces `DsaNoticeInput` (zod, shared), `createDsaNotice(c, input): Promise<{ id: string; token: string } | null>` (null = target not public), and `POST /dsa-notice`.

- [ ] **Step 1: Shared schema.** Append to `packages/shared/src/moderation.ts`:

```ts
/**
 * DSA Art. 16 notice (spec §8). Unauthenticated: the reporter proves a working
 * inbox by confirming. `goodFaith` must be literally true (Art. 16(2)(d)).
 */
export const DsaNoticeInput = z
  .object({
    postId: z.string().uuid().optional(),
    commentId: z.string().uuid().optional(),
    reason: z.enum(REPORT_REASONS),
    statement: z.string().trim().min(1).max(5000),
    reporterName: z.string().trim().min(1).max(200),
    reporterEmail: z.email().toLowerCase(),
    goodFaith: z.literal(true),
    turnstileToken: z.string().min(1),
  })
  .refine((t) => (t.postId === undefined) !== (t.commentId === undefined), {
    message: "exactly one of postId/commentId",
  });
export type DsaNoticeInputT = z.infer<typeof DsaNoticeInput>;
```

`z.email()` is zod 4's top-level email schema; `schemas.ts` builds `NormalizedEmail` the same way (`z.email().toLowerCase()`).

- [ ] **Step 2: Binding.** Add to `apps/api/wrangler.jsonc`'s `ratelimits` array, after the last entry (its `namespace_id` is "1011" at 03042ac; use the next unused id):

```jsonc
    {
      // DSA notice intake (spec §8) — unauthenticated, so per-IP. 5/min: a
      // notice also costs the sender a confirmable inbox, so this only has to
      // stop scripted floods.
      "name": "DSA_LIMITER",
      "namespace_id": "1012",
      "simple": { "limit": 5, "period": 60 }
    }
```

Then hand-add `DSA_LIMITER: RateLimit;` to `src/worker-configuration.d.ts` below `SEARCH_LIMITER`, with a comment matching `SEARCH_LIMITER`'s.

- [ ] **Step 3: Failing route test** (pool; mock Turnstile exactly as `test/forgot-password.test.ts` does, and capture Postmark as in `test/moderation-notify.test.ts`). Cases, written out in full:
  - a valid notice on a **published, visible** post → `202`; one `dsa_notices` row with `email_verified_at IS NULL` and a 64-hex `verify_token_hash`; one email to `reporterEmail` whose body contains `/dsa-notice/confirm?token=`; the raw token appears in the email but **not** in the row.
  - ⚠️ **Review Focus 3:** a **hidden** post, a **draft**, a **nonexistent** uuid, and a **hidden or deleted** comment each give a byte-identical `404 NOT_FOUND`, with **no row and no email**.
  - `goodFaith: false`, both/neither target, a blank statement → `400 INVALID_INPUT`, no row.
  - a cross-site Origin → `403` before anything else; Turnstile failure → `403 FORBIDDEN`, no row.
  - ⚠️ **AC-1, intake half:** after a notice is filed, `reports` has no new row and `posts.hidden_at` is unchanged.
  - the 6th request from one IP in a minute → `429` (use `test/helpers/limiter-window.ts` the way the search-limiter test does; read it first).
- [ ] **Step 4:** run → FAIL.
- [ ] **Step 5: Implement.** `apps/api/src/moderation/dsa-notices.ts`:

```ts
/**
 * DSA notices (spec §3.3, §8). ⚠️ AC-1: NOTHING here touches `reports`,
 * `hidden_at` or `maybeAutoHide`. A notice is queue input for a human only.
 */
import type { Client } from "pg";

import { base64urlEncode, sha256Hex } from "../auth/encoding";

import type { DsaNoticeInputT } from "@thinkersjournal/shared";

/** Insert a notice ONLY if its target is publicly visible. `null` = not (the caller 404s). */
export async function createDsaNotice(
  c: Client,
  input: Omit<DsaNoticeInputT, "turnstileToken" | "goodFaith">,
): Promise<{ id: string; token: string } | null> {
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(token);
  // ⚠️ The visibility predicate is INSIDE the INSERT … SELECT, so "is it
  // public" and "write the row" are one statement — no check-then-act gap.
  const { rows } =
    input.postId !== undefined
      ? await c.query<{ id: string }>(
          `INSERT INTO dsa_notices (reporter_email, reporter_name, good_faith, verify_token_hash, post_id, reason, statement)
           SELECT $1, $2, true, $3, p.id, $5, $6 FROM posts p
            WHERE p.id = $4 AND p.status = 'published' AND p.hidden_at IS NULL
           RETURNING id`,
          [input.reporterEmail, input.reporterName, hash, input.postId, input.reason, input.statement],
        )
      : await c.query<{ id: string }>(
          `INSERT INTO dsa_notices (reporter_email, reporter_name, good_faith, verify_token_hash, comment_id, reason, statement)
           SELECT $1, $2, true, $3, cm.id, $5, $6 FROM comments cm JOIN posts p ON p.id = cm.post_id
            WHERE cm.id = $4 AND cm.hidden_at IS NULL AND cm.deleted_at IS NULL
              AND p.status = 'published' AND p.hidden_at IS NULL
           RETURNING id`,
          [input.reporterEmail, input.reporterName, hash, input.commentId, input.reason, input.statement],
        );
  const row = rows[0];
  return row === undefined ? null : { id: row.id, token };
}
```

`apps/api/src/routes/dsa-notice.ts` → `handleDsaNotice`, in this order (the same shape as `routes/forgot-password.ts`; read it):
1. `checkOrigin` → 403.
2. JSON → `DsaNoticeInput.safeParse` → `400 INVALID_INPUT` with `fields`.
3. `enforceRateLimit(env.DSA_LIMITER, \`dsa:${ip}\`)`.
4. `verifyTurnstile` (in try/catch → false) → `403 FORBIDDEN`.
5. `createDsaNotice` on `HYPERDRIVE_FRESH`. A malformed uuid can't reach SQL, because zod validates it. `null` → `errorResponse("NOT_FOUND", 404)`.
6. `ctx.waitUntil(postmarkSend(...))` with the confirmation link `${verificationLinkOrigin(request)}/dsa-notice/confirm?token=${encodeURIComponent(token)}`, logging on `false`. Subject: "Confirm your report to Thinkers Journal". Body: one sentence on what was reported, the link, "If you did not send this, ignore this email: nothing happens unless you confirm." All interpolations go through `escapeHtml` in the html body.
7. `202` with an empty body.

Register `{ method: "POST", pattern: "/dsa-notice", handler: handleDsaNotice }` and add it to `pipeline-exempt.ts` (`// spec §8 — unauthenticated by design (decision #6); inline checkOrigin + DSA_LIMITER + Turnstile.`).

⚠️ `hidden-at-read-guard.node.test.ts` scans `src/routes/` only, so `moderation/dsa-notices.ts` is outside it. Its reads **do** filter `hidden_at IS NULL`; keep it that way.
- [ ] **Step 6:** run the route test, `route-protection`, `error-envelope` → PASS. Commit `feat(dsa): unauthenticated notice intake (Part of #113)`.

---

### Task 3: Confirmation, AC-1, and the reaper

**Files:** modify `apps/api/src/moderation/dsa-notices.ts`, `apps/api/src/routes/dsa-notice.ts`, `apps/api/src/routes.ts`, `apps/api/src/index.ts`, `pipeline-exempt.ts`; tests `apps/api/test/dsa-notice-confirm.test.ts`, **`apps/api/test/dsa-ac1.test.ts`**.

**Interfaces:** `peekDsaToken(c, token): Promise<boolean>`, `confirmDsaNotice(c, token): Promise<boolean>`, `reapUnconfirmedDsaNotices(env, ctx): Promise<number>`; routes `GET /dsa-notice/confirm?token=`, `POST /dsa-notice/confirm`.

- [ ] **Step 1: The AC-1 test, written FIRST and in full.** Create `apps/api/test/dsa-ac1.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import { maybeAutoHide, AUTO_HIDE_REPORTER_THRESHOLD } from "../src/moderation/auto-hide";
import { createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";

/**
 * ⚠️ AC-1 — BINDING MERGE CONDITION (spec §8, §12): "A DSA notice NEVER counts
 * toward the auto-hide threshold." Three throwaway addresses must not be able
 * to hide any post on the site.
 *
 * This test is only evidence if it is shown to FAIL against an implementation
 * that counts notices — see Step 3's mutation, which the PR must report.
 */
async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

afterEach(async () => {
  await deleteCreatedUsers();
});

async function confirmedNotices(postId: string, n: number): Promise<void> {
  await ctxRun(async (c) => {
    for (let i = 0; i < n; i++) {
      await c.query(
        `INSERT INTO dsa_notices (reporter_email, reporter_name, good_faith, email_verified_at, verify_token_hash, post_id, reason, statement)
         VALUES ($1, 'Throwaway', true, now(), $2, $3, 'sexual', 'illegal')`,
        [`throwaway${i}-${crypto.randomUUID()}@example.test`, crypto.randomUUID(), postId],
      );
    }
  });
}

async function memberReports(postId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const reporter = await createVerifiedActor();
    await ctxRun((c) => c.query(`INSERT INTO reports (post_id, reporter_id, reason) VALUES ($1, $2, 'spam')`, [postId, reporter.userId]));
  }
}

async function hiddenAt(postId: string): Promise<Date | null> {
  return ctxRun(async (c) => (await c.query<{ h: Date | null }>(`SELECT hidden_at AS h FROM posts WHERE id = $1`, [postId])).rows[0]!.h);
}

describe("⚠️ AC-1 — DSA notices never count toward auto-hide", () => {
  it("THREE confirmed DSA notices alone do not hide a post", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await confirmedNotices(postId, AUTO_HIDE_REPORTER_THRESHOLD);
    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).toBeNull();
    expect(await hiddenAt(postId)).toBeNull();
  });

  it("threshold−1 member reports + three confirmed DSA notices still do not hide it", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await memberReports(postId, AUTO_HIDE_REPORTER_THRESHOLD - 1);
    await confirmedNotices(postId, 3);
    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).toBeNull();
    expect(await hiddenAt(postId)).toBeNull();
  });

  it("CONTROL: threshold member reports DO hide it (proves this harness can observe a hide)", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await memberReports(postId, AUTO_HIDE_REPORTER_THRESHOLD);
    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).not.toBeNull();
    expect(await hiddenAt(postId)).not.toBeNull();
  });
});
```

- [ ] **Step 2:** run it. The schema exists (Task 1) and nothing counts notices, so it **passes** immediately, which proves nothing yet. **Step 3 is mandatory.**
- [ ] **Step 3: ⚠️ The AC-1 mutation (report its result in the PR).** In `apps/api/src/moderation/auto-hide.ts`, temporarily make the counted set include confirmed DSA notices. Replace the `FROM reports` in `maybeAutoHide`'s count query with:

```sql
FROM (SELECT reporter_id::text AS reporter_id, post_id, comment_id, created_at FROM reports
      UNION ALL
      SELECT reporter_email::text, post_id, comment_id, created_at FROM dsa_notices
       WHERE email_verified_at IS NOT NULL) reports
```

Adjust the column list so the rest of that query is unchanged; read it first, because it counts distinct reporters. Run `dsa-ac1.test.ts`. **Expected: the first two cases FAIL** (the post is hidden) and the control passes. Restore `auto-hide.ts` and re-run → PASS. Paste both runs' summary lines into the PR body. Without this, AC-1 is unmet.

- [ ] **Step 4: Failing confirm/reaper tests** (`dsa-notice-confirm.test.ts`, pool), written out in full:
  - ⚠️ **Review Focus 2:** `GET /dsa-notice/confirm?token=` three times → each `200 { ok: true }`, and the row stays `email_verified_at IS NULL`.
  - `POST /dsa-notice/confirm { token }` → `200`; `email_verified_at` set; a second POST → `400 INVALID_TOKEN`; `reports` and `hidden_at` unchanged (AC-1, confirm half).
  - an unknown token → `400 INVALID_TOKEN` on both GET and POST.
  - a token for a notice older than 7 days → `400 INVALID_TOKEN`, even though the reaper hasn't run yet.
  - ⚠️ **Review Focus 5:** `reapUnconfirmedDsaNotices` deletes an unconfirmed notice backdated 8 days, keeps an unconfirmed one at 6 days, and keeps a **confirmed** one backdated 30 days.
  - `scheduled` with cron `"30 3 * * *"` runs the DSA reaper as well as the account reaper. Assert the 8-day notice is gone after the handler.
- [ ] **Step 5: Implement.** Append to `moderation/dsa-notices.ts`:

```ts
/** Confirmation links stop working, and unconfirmed notices are reaped, after this. */
export const DSA_CONFIRM_WINDOW_DAYS = 7;

export async function peekDsaToken(c: Client, token: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM dsa_notices
      WHERE verify_token_hash = $1 AND email_verified_at IS NULL
        AND created_at > now() - make_interval(days => $2::int)`,
    [await sha256Hex(token), DSA_CONFIRM_WINDOW_DAYS],
  );
  return (rowCount ?? 0) > 0;
}

/** ⚠️ Confirms ONLY. AC-1: it does not count, report, or hide anything. */
export async function confirmDsaNotice(c: Client, token: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE dsa_notices SET email_verified_at = now()
      WHERE verify_token_hash = $1 AND email_verified_at IS NULL
        AND created_at > now() - make_interval(days => $2::int)`,
    [await sha256Hex(token), DSA_CONFIRM_WINDOW_DAYS],
  );
  return (rowCount ?? 0) > 0;
}
```

and, in the same file, `reapUnconfirmedDsaNotices(env, ctx)`: a `withClient(env.HYPERDRIVE_FRESH, …)` running `DELETE FROM dsa_notices WHERE id IN (SELECT id FROM dsa_notices WHERE email_verified_at IS NULL AND created_at < now() - make_interval(days => $1::int) ORDER BY created_at LIMIT 500)`, logging the count when it's non-zero. This is the same shape as `auth/reap-unverified.ts`; import `withClient` from `../db/client`.

Routes in `routes/dsa-notice.ts`: `handlePeekDsaToken` (GET; `?token=`; `200 { ok: true }` or `400 INVALID_TOKEN`) and `handleConfirmDsaNotice` (POST; `checkOrigin`; body `{ token: string }`; `200 {}` or `400 INVALID_TOKEN`). Register both; add the POST to `pipeline-exempt.ts`.

In `apps/api/src/index.ts`'s `scheduled`, inside the `"30 3 * * *"` branch, add `ctx.waitUntil(reapUnconfirmedDsaNotices(env, ctx));` next to `reapUnverifiedAccounts`.
- [ ] **Step 6:** run `dsa-ac1`, `dsa-notice-confirm`, `route-protection`, `reap-unverified` → PASS. Commit `feat(dsa): confirmation (peek on GET, confirm on POST) + the unconfirmed-notice reaper; AC-1 pinned (Part of #113)`.

---

### Task 4: Moderators rule; reporters are told

**Files:** modify `apps/api/src/moderation/decide.ts`, `apps/api/src/routes/admin.ts`, `packages/shared/src/admin.ts`; create `apps/api/src/moderation/notify-reporter.ts`; tests `apps/api/test/admin-dsa-notices.test.ts`, existing `admin-decision-route.test.ts` (must stay green).

**Interfaces:** `DecisionResult.dsaReporters: readonly { email: string; noticeId: string }[]`; `listOpenDsaNotices(c)`; route `GET /admin/dsa-notices`; `sendDsaOutcome(env, to, { decision, reason, subject, postTitle }): Promise<boolean>`.

- [ ] **Step 1: Failing tests** (pool, `admin-decision-route.test.ts`'s harness copied **by symbol**: its imports, `TEAM`/`AUD`/`KID`, `b64url`, `b64urlJson`, **all five** module-scope `let`s, `makeJwt`, `ctxRun`, `call`, and its module-level `beforeEach`/`afterEach` pair). Cases, written out in full:
  - `GET /admin/dsa-notices`: Access-gated (no JWT → 401). It lists **only confirmed, unresolved** notices, oldest first, each with target kind and id, excerpt, reason, statement, reporter name and email. An unconfirmed notice is absent.
  - ⚠️ **Review Focus 4:** two confirmed notices + one unconfirmed on one post, then `POST /admin/decision { decision: "remove" }`. Both confirmed notices have `resolved_at` set and `resolution_action_id` = the decision's `actionId`. The unconfirmed one is untouched. Both reporters get one email each, containing the statement of reasons, and the author gets their usual notice.
  - a `restore` of never-hidden content (a dismissal) still resolves the notices and tells each reporter "no action was taken". It still sends the author nothing, which is existing behaviour.
  - a notice on a **different** post is not resolved.
  - **atomicity:** if the decision's `recordModerationAction` fails (force it with an invalid `violationCategory` via a direct `applyDecision` call), no notice is resolved.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** In `decide.ts`, inside the decision transaction, **immediately after** `recordModerationAction(...)` returns `actionId`, and before the purge-target computation:

```ts
    // DSA (spec §8): a ruling on this content answers every CONFIRMED, open
    // notice about it — in the same transaction as the ruling, so the notices
    // can never claim a resolution the log does not contain. Unconfirmed
    // notices are inert and stay so (they are reaped, never resolved).
    const { rows: dsaRows } = await c.query<{ id: string; reporter_email: string }>(
      `UPDATE dsa_notices SET resolved_at = now(), resolution_action_id = $2
        WHERE ${input.subject === "post" ? "post_id" : "comment_id"} = $1
          AND email_verified_at IS NOT NULL AND resolved_at IS NULL
        RETURNING id, reporter_email`,
      [row.id, actionId],
    );
```

Add `dsaReporters: dsaRows.map((r) => ({ email: r.reporter_email, noticeId: r.id }))` to the returned `DecisionResult`, and the field to the interface.

`moderation/notify-reporter.ts` → `sendDsaOutcome`, the same transport and never-throw discipline as `notify-author.ts`. Copy per decision: remove → "We reviewed the content you reported and removed it."; keep_hidden → "…and it will stay hidden."; restore → "…and decided it does not break our rules or the law, so no action was taken." It then names the content (as `notify-author.ts` does), quotes "Reason given by the moderator:" plus the reason, and says, for DSA Art. 17-style transparency, that the decision was made by a human moderator. **No appeal link**: the reporter isn't the actioned party, and plan B's appeals are for the actioned user.

In `handleAdminDecision`, after the existing author notice, add:

```ts
  for (const r of result.dsaReporters) {
    ctx.waitUntil(
      sendDsaOutcome(env, r.email, {
        decision: decision as DecisionKind,
        reason: reason.trim(),
        subject,
        postTitle: result.postTitle,
      }).then((sent) => {
        if (!sent) console.error("dsa outcome not sent", { noticeId: r.noticeId, actionId: result.actionId });
      }),
    );
  }
```

`GET /admin/dsa-notices` → a new `handleListDsaNotices` in `routes/admin.ts` (`requireAdmin`, no `checkOrigin` on GET, the same shape as `handleListMediaAccessRequests`) over `listOpenDsaNotices(c)` in `moderation/dsa-notices.ts`. That query **reads hidden rows on purpose**: a notice may name content that auto-hide has since hidden. It lives outside `src/routes/`, so the structural guard doesn't scan it; say so in its header. Return ISO strings; add `AdminDsaNotice` and `AdminDsaNoticesResponse` to `packages/shared/src/admin.ts`.
- [ ] **Step 4:** run `admin-dsa-notices`, `admin-decision-route`, `moderation-actions.db`, `route-protection` → PASS. Commit `feat(dsa): moderators rule through the existing decision route; notices resolve in the same transaction; reporters get a statement of reasons (Part of #113)`.

---

### Task 5: The pages

| Page | Model it on | Behaviour |
|---|---|---|
| `apps/web/src/pages/dsa-notice.astro` | `forgot-password.astro` (Turnstile, `setPublicPageCsp(Astro, { turnstile: true })`, Origin forwarded verbatim) | `?post=<id>` or `?comment=<id>`. The form takes name, email, reason (`REPORT_REASONS`), statement (`maxlength=5000`), and a required "I believe in good faith that this information is accurate and complete" checkbox. POST → `/dsa-notice`. `202` → "Check your email to confirm your report. Nothing happens until you do."; `404` → "That content isn't available to report."; `429` → the standard too-many message. |
| `apps/web/src/pages/dsa-notice/confirm.astro` | `reset-password.astro` (token page) | GET `?token=` → peek → a page with one "Confirm my report" button. **No API POST on GET.** POST → `/dsa-notice/confirm`. |
| `apps/web/src/pages/admin/dsa-notices.astro` | `admin/queue.astro` (guard first) | Lists the notices. Each item has the same three decision buttons and the required reason as the queue. The form POSTs to the page, which calls `adminApiFetch("/admin/decision", …)` with `subject`/`subjectId` from the notice. **The only decision path is `/admin/decision`** (PM ruling). |
| `[handle]/[slug].astro` + the comment report control (`scripts/report-control.ts`) | — | Beside each existing member "Report" control, a plain link `Report illegal content (no account needed)` → `/dsa-notice?post=<id>` or `?comment=<id>`. Signed-out visitors see it too: that's the point. |
| `admin/queue.astro` nav | — | A link to `/admin/dsa-notices`. |

- [ ] **Step 1: Failing source pins** in `apps/web/test/dsa-pages.test.ts` (`stripComments`, as `admin-media-access-page.test.ts` does):
  - `dsa-notice/confirm.astro`: its only `method: "POST"` api call is inside `if (Astro.request.method === "POST")`.
  - `admin/dsa-notices.astro`: the guard is the first statement, and it calls `adminApiFetch("/admin/decision"` and no other mutating admin path.
  - `dsa-notice.astro`: it includes the `goodFaith` checkbox with `required`, and `setPublicPageCsp(Astro, { turnstile: true })`.
  - `[slug].astro`: it contains `/dsa-notice?post=`.
- [ ] **Step 2:** build the pages; run → PASS; `pnpm typecheck` clean.
- [ ] **Step 3: e2e** `e2e/dsa-notice.spec.ts`. Signed out, open a published post, follow "Report illegal content", and submit (the e2e environment's Turnstile is Cloudflare's always-pass test key; read `e2e/signup.spec.ts` for how it's handled). Assert the "check your email" text. Fetch the token through a `TEST_ROUTES`-gated `__test/last-dsa-token` route that mirrors `password-reset.ts`'s `TEST_LAST_RESET_TOKEN_KEY` stash (the same gate and origin check, KV-stashed **only** when `env.TEST_ROUTES === "1"`). Open the confirm page, click confirm, and assert success. Assert the post is still publicly visible (AC-1, end to end).
- [ ] **Step 4:** commit `feat(web): DSA notice form, confirmation, and admin list (Part of #113)`.

---

### Task 6: Docs

- [ ] `docs/legal/community-guidelines.md` §2: add a "Reporting illegal content without an account" bullet. It describes the form, the email confirmation, human review, and that the reporter is told the outcome. It also says "notices are reviewed by a person; they never hide content automatically" (that's AC-1, stated publicly).
- [ ] `docs/legal/privacy-policy.md` §1/§4: what a notice collects (name, email, the statement), why (DSA Art. 16; to send the outcome), that it is shown to moderators and **never** to the reported author, and that an unconfirmed notice is deleted after 7 days. Add a bracketed attorney note on retention of **confirmed** notices: none is implemented, so they're kept indefinitely like the moderation log. Flag the question; don't decide it.
- [ ] The spec §8: add the status line `**Status (2026-10-01):** BUILT — plan C (docs/superpowers/plans/2026-10-01-m4-dsa-notice-intake.md). Deviation: reporter_name + good_faith added for DSA Art. 16(2)(c)/(d); own admin list instead of the review queue (PM ruling).`
- [ ] Commit `docs: DSA notice channel and its data (Part of #113)`.

## Whole-branch checks

- [ ] `pnpm typecheck`; `pnpm -r run test` green except the four known local `media-backfill.test.ts` timeouts (same four by name); `pnpm run test:e2e` green.
- [ ] **PR body:** the AC-1 mutation's FAIL and PASS summary lines (Task 3 Step 3) — **required for merge**, per spec §12.
- [ ] Deploy note: migration **before** code. The `DSA_LIMITER` binding ships in `wrangler.jsonc` with the code deploy.
