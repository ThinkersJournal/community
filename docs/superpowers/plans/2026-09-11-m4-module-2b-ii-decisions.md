# M4 Module 2b-ii — Content Decisions, Author-Facing Hidden State, and the Notice Channel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a human moderator the three content decisions the queue exists to serve — Restore, Keep hidden, Remove — each writing one audit row and telling the author why.

**Architecture:** One Access-gated `POST /admin/decision` applies a visibility effect and appends a `moderation_actions` row **in one bounded transaction**, so an audit log entry and the state it describes can never disagree. The author is then told over direct transactional email on the `"outbound"` Postmark stream — the codebase's one prefs-bypassing path — and sees a "Hidden pending review" banner in their own editor. No new column and no second visibility predicate: `hidden_at` remains the only one.

**Tech Stack:** Cloudflare Workers (workerd), Neon Postgres 18 via Hyperdrive, `pg`, vitest (`pool` = real workerd, `node` = plain Node), Astro SSR for the web Worker, Postmark.

**Spec:** `docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md` — §4.3 (decisions), §4.4 (author-facing hidden state), §7 (telling users). Read it alongside this plan.

**Base:** `main` @ `195fabc9`. Branch `feat/m4-2b-ii`, worktree `C:\Projects\tjc-2bii`.

## Global Constraints

- **PostgreSQL 18 on Neon via two Hyperdrive bindings** — `HYPERDRIVE_FRESH` (cache-disabled) and `HYPERDRIVE_CACHED`. Postgres dialect only; this is not SQLite and not D1.
- ⚠️ **AC-5, binding:** *"No second visibility predicate is introduced on `posts`/`comments`."* `hidden_at IS NULL` is the only one. Adding `deleted_at` to `posts` — or any second column a public read must independently remember — widens the leak surface the structural guard exists to close. **Removal reuses `hidden_at`; the distinction between "hidden pending review" and "removed, final" lives in the audit log, not in a second column.**
- ⚠️ **A route under `src/routes/**` that READS `posts`/`comments` trips `test/hidden-at-read-guard.node.test.ts` and needs an allowlist entry with a written justification.** That is the guard working, not an obstacle to route around. ⚠️ **But do not over-read its coverage** — measured, it scans `src/routes/**` only, examines `FROM`/`JOIN`/`USING` references rather than UPDATE targets, and matches literal table names rather than interpolations. **A file outside that tree is not "cleared" by it; it is simply unseen.** Adding a speculative allowlist entry is worse than none: the suite has a stale-exemption check that fails on an entry matching nothing.
- ⚠️ **Automation never decides.** Auto-hide is provisional and reversible; only a human writes a `content_*` action.
- **`moderation_actions` is append-only** — migration 0013 carries a `BEFORE UPDATE OR DELETE` trigger that raises. `recordModerationAction` exposes an INSERT and nothing else. To correct a row, append another.
- **Moderation notices never use the `notifications` table.** It demands a human actor, forbids self-addressing, is suppressed by blocks and is silenceable by prefs. Notices go as direct email on the `"outbound"` stream, exactly like `sendVerificationEmail`. Users cannot opt out of being told they were actioned.
- **Account actions are out of scope** (decision #3 — they are module 2c). This module ships content outcomes only.
- ⚠️ **Command form:** always `pnpm --filter @thinkersjournal/api exec vitest run --project {node|pool} <file>`. The direct `./node_modules/.bin/vitest` form fails to load the config — `pg-protocol` will not resolve without pnpm's path injection. Do not "fix" a failure by switching to it.

## Rulings — decisions the spec does not settle

Recorded here so an implementer does not re-derive them, and so a reviewer can reject them on the record.

**R1. One route, not three.** `POST /admin/decision` takes a `decision` discriminator. The spec calls these *"exactly three content outcomes"* of one operation; three routes would triplicate auth, validation and the transaction. *Cost if wrong: one route rename.*

**R2. `keep_hidden` and `remove` use `hidden_at = COALESCE(hidden_at, now())`.** The queue surfaces *reported* items, and auto-hide is threshold-based — so an item can reach review **without** being hidden, and the spec offers no fourth outcome for "hide this". `COALESCE` makes both decisions total: an already-hidden item **keeps its original hide timestamp** (which is evidence of when it was hidden), an un-hidden one becomes hidden now. *Cost if wrong: a moderator cannot action a reported-but-unhidden item, which would make the queue's most common case unreachable.*

**R3. `restore` sets `hidden_at = NULL`** — the first un-hide path in the codebase (spec §4.3).

**R4. The visibility write and the audit append share one transaction** (`BEGIN_BOUNDED_TX`). An audit log that can disagree with the state it describes is worse than no audit log, and this is the one place they are written together. *Cost if wrong: a crash between the two writes leaves a ban with no record, or a record with no ban.*

**R5. The email is sent AFTER the commit, via `ctx.waitUntil`, and never fails the decision.** A moderation decision that succeeded in the database must not report failure because Postmark was down. This matches `sendVerificationEmail`'s never-throws discipline. *Cost if wrong: an author is actioned and not told — which is why Task 2 logs the failure rather than swallowing it silently.*

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/moderation/decide.ts` | **Create.** The transactional decision applier: visibility effect + audit row, atomically. Takes a caller's `Client`, opens no connection of its own — matching `actions.ts`, `auto-hide.ts`, `is-blocked.ts`. |
| `apps/api/src/moderation/notify-author.ts` | **Create.** The author notice on the `"outbound"` stream. Never throws. |
| `apps/api/src/routes/admin.ts` | **Modify.** `handleAdminDecision` — ⚠️ **inline `checkOrigin` FIRST** (the CSRF defense; admin routes do not run the mutating pipeline), then the Access gate, body validation, `applyDecision`, and the notice. |
| `apps/api/src/routes.ts` | **Modify.** Register `POST /admin/decision`. |
| `packages/shared/src/posts.ts` | **Modify.** `AuthoredPost` gains `hiddenAt: string \| null`. |
| `apps/api/src/routes/posts.ts` | **Modify.** The author's own read selects `hidden_at`. |
| `apps/web/src/pages/new-post.astro` | **Modify.** "Hidden pending review" banner with the appeal link. |
| `apps/api/test/hidden-at-read-guard.node.test.ts` | ⚠️ **UNCHANGED — do NOT add an allowlist entry.** See Task 1 Step 6: an entry for `decide.ts` matches nothing and trips the suite's stale-exemption check. |
| `apps/api/test/admin-decision-route.test.ts` | **Create.** The three decisions, the gate, the audit row, the transaction. |
| `apps/api/test/moderation-notify.test.ts` | **Create.** The notice's stream and never-throws property. |
| `apps/api/test/error-envelope.test.ts` | **UNCHANGED.** It auto-probes every mutating route from the `ROUTES` inventory, so registering the route is the whole change. Verify, don't edit. |

---

## Task 1: `POST /admin/decision` — the three content decisions

**Files:** create `src/moderation/decide.ts`, `test/admin-decision-route.test.ts`; modify `src/routes/admin.ts`, `src/routes.ts`, `test/route-protection.test.ts` (the `PIPELINE_EXEMPT` entry).

⚠️ **`test/hidden-at-read-guard.node.test.ts` and `test/error-envelope.test.ts` are NOT modified** — see Steps 6 and 7. Editing either is a defect, not a completion: the guard has a stale-exemption check that an entry for `decide.ts` would trip.

**Interfaces:**

- Consumes: `recordModerationAction(c: Client, input: ModerationActionInput): Promise<string>` and the types `ModerationActionKind` / `ViolationCategory` from `src/moderation/actions.ts`; `requireAdmin(request, env): Promise<AdminIdentity | Response>` where `AdminIdentity = { readonly email: string; readonly sub: string }`; `BEGIN_BOUNDED_TX` and `withClient(binding, ctx, fn)` from `src/db/client.ts`; `errorResponse(code, status)` from `src/http/errors.ts`.
- Produces, for Task 2:
```ts
export type DecisionKind = "restore" | "keep_hidden" | "remove";
export interface DecisionInput {
  readonly subject: "post" | "comment";
  readonly subjectId: string;
  readonly decision: DecisionKind;
  readonly reason: string;
  readonly actorAdmin: string;
  readonly violationCategory?: ViolationCategory;
  readonly internalNote?: string;
}
export interface DecisionResult {
  readonly actionId: string;
  readonly authorEmail: string;
  readonly hidden: boolean;
}
export async function applyDecision(c: Client, input: DecisionInput): Promise<DecisionResult | null>;
```
`null` means the subject does not exist — the route turns that into a 404.

- [ ] **Step 1: Write the failing route test**

Create `apps/api/test/admin-decision-route.test.ts`. Mirror `test/admin-queue-route.test.ts` for the Access-header harness (read it first — reuse how it mints or stubs the `Cf-Access-Jwt-Assertion` header verbatim rather than inventing a second approach), and seed posts/comments through `withClient(env.HYPERDRIVE_FRESH, ctx, …)` as `test/reap-unverified.test.ts` does.

The suite must assert:

```ts
  it("restore clears hidden_at and appends a content_restore action", async () => {
    const { postId } = await seedHiddenPost();
    const res = await decide({ subject: "post", subjectId: postId, decision: "restore", reason: "Report was mistaken." });
    expect(res.status).toBe(200);
    expect(await hiddenAtOf("posts", postId)).toBeNull();
    expect(await lastActionFor(postId)).toMatchObject({ action: "content_restore", reason: "Report was mistaken." });
  });

  it("keep_hidden PRESERVES an existing hidden_at rather than restamping it", async () => {
    // ⚠️ The original timestamp is evidence of WHEN the content was hidden.
    // A decision that restamps it destroys that, and the destruction is invisible.
    const { postId, hiddenAt } = await seedHiddenPost();
    await decide({ subject: "post", subjectId: postId, decision: "keep_hidden", reason: "Violates the guidelines." });
    expect(await hiddenAtOf("posts", postId)).toEqual(hiddenAt);
  });

  it("keep_hidden HIDES a reported item that was never auto-hidden", async () => {
    // Auto-hide is threshold-based, so an item can reach review un-hidden.
    // Without this, the queue's most common case has no reachable outcome.
    const { postId } = await seedReportedButVisiblePost();
    await decide({ subject: "post", subjectId: postId, decision: "keep_hidden", reason: "Violates the guidelines." });
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
  });

  it("remove hides permanently and appends content_remove", async () => {
    const { postId } = await seedReportedButVisiblePost();
    await decide({ subject: "post", subjectId: postId, decision: "remove", reason: "Repeat infringement." });
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
    expect(await lastActionFor(postId)).toMatchObject({ action: "content_remove" });
  });

  it("decides on a COMMENT as well as a post", async () => {
    const { commentId } = await seedHiddenComment();
    const res = await decide({ subject: "comment", subjectId: commentId, decision: "restore", reason: "Mistaken." });
    expect(res.status).toBe(200);
    expect(await hiddenAtOf("comments", commentId)).toBeNull();
  });

  // ⚠️ AC: the audit row and the state it describes can never disagree.
  it("writes NO action row when the subject does not exist", async () => {
    const before = await actionCount();
    const res = await decide({ subject: "post", subjectId: crypto.randomUUID(), decision: "remove", reason: "x" });
    expect(res.status).toBe(404);
    expect(await actionCount()).toBe(before);
  });

  it("401s without a Cloudflare Access assertion", async () => {
    const res = await decideRaw({ headers: { Origin: ALLOWED_ORIGIN } });
    expect(res.status).toBe(401);
  });

  // ⚠️ THE CSRF CASE. Access proves WHO, not that the request was INTENDED:
  // Cloudflare injects the assertion from the CF_Authorization cookie, so a
  // cross-site form post from a logged-in moderator's browser carries a VALID
  // one. Without the inline checkOrigin this returns 200 and removes content.
  it("403s a VALID admin assertion sent from a foreign origin", async () => {
    const { postId } = await seedHiddenPost();
    const res = await decideRaw({
      headers: { ...adminHeaders(), Origin: "https://evil.test" },
      body: { subject: "post", subjectId: postId, decision: "remove", reason: "x" },
    });
    expect(res.status).toBe(403);
    // and it must not have acted
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
    expect(await lastActionFor(postId)).toBeNull();
  });

  it("400s an unknown decision value", async () => {
    const { postId } = await seedHiddenPost();
    const res = await decide({ subject: "post", subjectId: postId, decision: "banish" as never, reason: "x" });
    expect(res.status).toBe(400);
  });

  it("400s an empty reason — the statement of reasons is not optional", async () => {
    const { postId } = await seedHiddenPost();
    const res = await decide({ subject: "post", subjectId: postId, decision: "remove", reason: "   " });
    expect(res.status).toBe(400);
  });

  // CONTROL: without this, every 4xx above is indistinguishable from
  // "this harness cannot reach the route at all".
  it("CONTROL: a well-formed decision from an admin succeeds", async () => {
    const { postId } = await seedHiddenPost();
    expect((await decide({ subject: "post", subjectId: postId, decision: "restore", reason: "ok" })).status).toBe(200);
  });
```

- [ ] **Step 2: Run it — expect FAIL**

`pnpm --filter @thinkersjournal/api exec vitest run --project pool test/admin-decision-route.test.ts`
Expected: FAIL — the route does not exist, so every case 404s on an unregistered path.

- [ ] **Step 3: Write the decision applier**

Create `apps/api/src/moderation/decide.ts`:

```ts
/**
 * THE ONE WAY a content decision is applied.
 *
 * ⚠️ THE VISIBILITY WRITE AND THE AUDIT APPEND SHARE ONE TRANSACTION. An audit
 * log that can disagree with the state it describes is worse than no audit log,
 * and this is the only place the two are written together. See R4 in the plan.
 *
 * ⚠️ NO SECOND VISIBILITY PREDICATE (AC-5). `hidden_at` is the only column that
 * governs visibility. "Removed, final" differs from "hidden pending review" by
 * the `content_remove` row in the audit log, NOT by a second column — a second
 * column would be one every public read must independently remember, and the
 * structural guard cannot enforce what it does not know about.
 *
 * Takes the caller's existing `pg.Client` and never opens its own connection,
 * matching actions.ts / auto-hide.ts / is-blocked.ts.
 */
import type { Client } from "pg";

import { BEGIN_BOUNDED_TX } from "../db/client";
import { recordModerationAction, type ModerationActionKind, type ViolationCategory } from "./actions";

export type DecisionKind = "restore" | "keep_hidden" | "remove";

export interface DecisionInput {
  readonly subject: "post" | "comment";
  readonly subjectId: string;
  readonly decision: DecisionKind;
  /** The statement of reasons (DSA). Shown to the author. */
  readonly reason: string;
  /** Access identity (email) of the acting human. */
  readonly actorAdmin: string;
  readonly violationCategory?: ViolationCategory;
  readonly internalNote?: string;
}

export interface DecisionResult {
  readonly actionId: string;
  /** Whose content it was — Task 2 emails them. */
  readonly authorEmail: string;
  /** Visibility AFTER the decision. */
  readonly hidden: boolean;
}

const ACTION_FOR: Readonly<Record<DecisionKind, ModerationActionKind>> = {
  restore: "content_restore",
  keep_hidden: "content_keep_hidden",
  remove: "content_remove",
};

/**
 * ⚠️ `COALESCE(hidden_at, now())` for keep_hidden and remove, NOT `now()`.
 * An already-hidden item keeps its ORIGINAL hide timestamp, which is evidence of
 * when it was hidden; restamping destroys that and the destruction is invisible.
 * An item that reached review WITHOUT being auto-hidden (auto-hide is
 * threshold-based) becomes hidden now — otherwise the queue's most common case
 * would have no reachable outcome. See R2.
 */
const HIDDEN_AT_SQL: Readonly<Record<DecisionKind, string>> = {
  restore: "NULL",
  keep_hidden: "COALESCE(hidden_at, now())",
  remove: "COALESCE(hidden_at, now())",
};

export async function applyDecision(
  c: Client,
  input: DecisionInput,
): Promise<DecisionResult | null> {
  const table = input.subject === "post" ? "posts" : "comments";

  await c.query(BEGIN_BOUNDED_TX);
  try {
    // The subject id is a bound parameter; `table` and the hidden_at expression
    // are chosen from the two closed maps above and are never caller text.
    const { rows } = await c.query<{ author_id: string; hidden_at: Date | null; email: string }>(
      `UPDATE ${table} AS t
          SET hidden_at = ${HIDDEN_AT_SQL[input.decision]}
        FROM users u
       WHERE t.id = $1 AND u.id = t.author_id
       RETURNING t.author_id, t.hidden_at, u.email`,
      [input.subjectId],
    );

    const row = rows[0];
    if (row === undefined) {
      // No such subject: commit nothing, and append NO action row. An audit
      // entry for content that does not exist is a lie in the log.
      try {
        await c.query("ROLLBACK");
      } catch {
        // Same reasoning as the catch below: a failed ROLLBACK must not become
        // the caller's error when the real answer is "no such subject".
      }
      return null;
    }

    const actionId = await recordModerationAction(c, {
      actorAdmin: input.actorAdmin,
      action: ACTION_FOR[input.decision],
      reason: input.reason,
      postId: input.subject === "post" ? input.subjectId : undefined,
      commentId: input.subject === "comment" ? input.subjectId : undefined,
      subjectUserId: row.author_id,
      subjectLabel: row.email,
      violationCategory: input.violationCategory,
      internalNote: input.internalNote,
    });

    await c.query("COMMIT");
    return { actionId, authorEmail: row.email, hidden: row.hidden_at !== null };
  } catch (err) {
    // ⚠️ THE ROLLBACK GETS ITS OWN try/catch SO IT CANNOT REPLACE THE ROOT
    // ERROR. If the connection is dead, ROLLBACK throws too and `throw err`
    // below would never run — the caller would see "connection terminated"
    // instead of whatever actually failed. Copied from signup.ts, which
    // documents the same reasoning, and it is not hypothetical here:
    // BEGIN_BOUNDED_TX sets `idle_in_transaction_session_timeout`, whose whole
    // job is to TERMINATE the backend connection (25P03) on this very
    // transaction primitive.
    try {
      await c.query("ROLLBACK");
    } catch {
      // Swallowed deliberately: the original error below is the useful one.
    }
    throw err;
  }
}
```

- [ ] **Step 4: Add the route handler**

In `apps/api/src/routes/admin.ts` add these imports — **all four**, not just the two new ones:

```ts
import { checkOrigin } from "../auth/csrf";
import { errorResponse } from "../http/errors";
import { applyDecision, type DecisionKind } from "../moderation/decide";
```

⚠️ `errorResponse` is **not** currently imported in `admin.ts` — the existing handlers there do not use it. Omitting it is `TS2304: Cannot find name 'errorResponse'` three times over.

Then add:

```ts
const DECISIONS: readonly DecisionKind[] = ["restore", "keep_hidden", "remove"];

/**
 * POST /admin/decision — the three content outcomes (spec §4.3).
 *
 * ⚠️ Account actions are NOT available here (decision #3); they are module 2c.
 * ⚠️ Only a human writes a `content_*` action — automation never decides.
 */
export async function handleAdminDecision(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // ⚠️ ORIGIN FIRST, BEFORE THE ACCESS GATE — and this is a real defense, not
  // ceremony. `src/admin/require-admin.ts`'s header spells out why: Cloudflare
  // injects the Access assertion from the `CF_Authorization` COOKIE, so a
  // cross-site form post from a logged-in moderator's browser WOULD carry a
  // valid one. ACCESS PROVES WHO; IT DOES NOT PROVE THE REQUEST WAS INTENDED.
  // Admin routes do not run `runMutatingPipeline` (that authenticates a member
  // session; admins are Access principals), so this check is inline, exactly as
  // signup and login do it.
  if (!checkOrigin(env, request)) {
    // ⚠️ `FORBIDDEN`, not a bespoke code. `ApiErrorCode` is a CLOSED union
    // (packages/shared/src/errors.ts) and signup/login both answer a rejected
    // origin with exactly this — deliberately the SAME response they give a
    // failed Turnstile, so the two defenses cannot be probed apart.
    return errorResponse("FORBIDDEN", 403);
  }

  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // The body was not JSON at all.
    return errorResponse("INVALID_JSON", 400);
  }

  const b = body as Record<string, unknown>;
  const subject = b["subject"];
  const subjectId = b["subjectId"];
  const decision = b["decision"];
  const reason = b["reason"];

  if (
    (subject !== "post" && subject !== "comment") ||
    typeof subjectId !== "string" || subjectId === "" ||
    typeof decision !== "string" || !DECISIONS.includes(decision as DecisionKind) ||
    // The statement of reasons is DSA-required and is shown to the author:
    // whitespace is not a reason.
    typeof reason !== "string" || reason.trim() === ""
  ) {
    // The shape was wrong. ⚠️ `INVALID_BODY` is NOT in this codebase's error
    // vocabulary — `packages/shared/src/errors.ts` defines `ApiErrorCode` as a
    // CLOSED union, and using a code outside it is a compile error, not a
    // runtime surprise. The vocabulary's own split is INVALID_JSON (not JSON at
    // all) vs INVALID_INPUT (JSON, wrong shape).
    return errorResponse("INVALID_INPUT", 400);
  }

  const result = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    applyDecision(c, {
      subject,
      subjectId,
      decision: decision as DecisionKind,
      reason: reason.trim(),
      actorAdmin: admin.email,
    }),
  );

  if (result === null) return errorResponse("NOT_FOUND", 404);

  return new Response(JSON.stringify({ actionId: result.actionId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 5: Register the route**

In `apps/api/src/routes.ts`, import `handleAdminDecision` alongside the existing admin imports and add the entry beside `/admin/queue`:

```ts
  // The three content decisions (M4 2b-ii, spec §4.3) — same Access trust
  // domain as /admin/queue. ⚠️ THE FIRST NON-GET ADMIN ROUTE: it does NOT run
  // runMutatingPipeline (that authenticates a member session; an admin is an
  // Access principal), so it is listed in PIPELINE_EXEMPT and defends itself
  // with an inline checkOrigin — see handleAdminDecision and the note in
  // src/admin/require-admin.ts on why an Access assertion alone is not enough.
  { method: "POST", pattern: "/admin/decision", handler: handleAdminDecision },
```

- [ ] **Step 6: Add the route to `PIPELINE_EXEMPT`, as a security decision**

`POST /admin/decision` is the **first non-GET admin route in the codebase**, and `test/route-protection.test.ts` asserts that every non-GET route either runs the mutating pipeline or is a listed exemption. Add to `PIPELINE_EXEMPT`:

```ts
  // The Access-gated moderation decision (M4 2b-ii). Cannot use
  // `runMutatingPipeline`: that authenticates a MEMBER SESSION, and an admin is
  // an Access principal — a different trust domain, and a member session confers
  // no admin authority. It defends itself instead with an inline `checkOrigin`
  // (see handleAdminDecision), which is required because Cloudflare injects the
  // Access assertion from the CF_Authorization COOKIE: without it, a cross-site
  // form post from a logged-in moderator's browser would carry a valid
  // assertion and drive a real content decision.
  "POST /admin/decision",
```

⚠️ **Adding to this set is a security decision, not a way to quiet a failing test.** The set's own header says so. The entry asserts two things: that the route *cannot* use the pipeline, **and** that it defends itself some other way. The second half is Step 4's `checkOrigin` — if that is ever removed, this exemption becomes a lie and the route becomes CSRF-able.

⚠️ **NO `hidden-at-read-guard` ALLOWLIST ENTRY IS NEEDED, and adding one BREAKS that suite.** The guard carries a **stale-exemption check** — an allowlist entry matching no current query fails it — so an entry for `decide.ts` fails *"every allowlist entry still matches a real unfiltered query"* **before any implementation defect exists**. Measured: adding one produced `1 failed | 3 passed`; with none, `4 passed`. **Do not add one.**

⚠️ **And be precise about WHY, because the obvious reason is not the operative one.** `decide.ts` does live in `src/moderation/`, outside the `src/routes/**` tree the guard scans (`ROUTES_DIR`, `hidden-at-read-guard.node.test.ts:43`) — the same boundary `queue.ts` sits on, which `admin-queue-route.test.ts` already documents. **But that is not what makes this query invisible.** Measured by placing this exact `UPDATE` inside `src/routes/`: the guard still reports zero violations, because the table is a **template interpolation** (`${table}`, never the literal `posts`/`comments`) and the UPDATE *target* is outside what the scanner examines at all. **So do not reason "it is in src/moderation, therefore it is safe" — a future author who moves this file would inherit a false sense of coverage.** Safety here comes from `requireAdmin` plus the inline `checkOrigin`, and from review. Not from that guard.

- [ ] **Step 7: Add the route to the error-envelope inventory**

`test/error-envelope.test.ts` imports `ROUTES` as its inventory and **already auto-probes every mutating route not listed in `ERROR_FREE`** — so a freshly-registered `POST /admin/decision` is covered the moment Step 5 lands, with no edit to that file. **Verify that rather than assuming it:** run the suite and confirm the count rises. Do **not** add the route to `ERROR_FREE` or any exemption list — it is not exempt.

```
pnpm --filter @thinkersjournal/api exec vitest run --project pool test/error-envelope.test.ts
```

- [ ] **Step 8: Run — expect PASS**

```
pnpm --filter @thinkersjournal/api exec vitest run --project pool test/admin-decision-route.test.ts
pnpm --filter @thinkersjournal/api exec vitest run --project pool test/route-protection.test.ts
pnpm --filter @thinkersjournal/api exec vitest run --project node test/hidden-at-read-guard.node.test.ts
pnpm --filter @thinkersjournal/api run typecheck
```

- [ ] **Step 9: ⚠️ Prove the guards can fail, FOR THEIR OWN REASONS**

A test that dies only when you delete the feature says nothing about the realistic wrong implementation. Run each mutation, capture the output, restore with `git checkout -- <file>`, confirm `git status --porcelain` is empty, and put all four in your report:

1. Change `keep_hidden`'s `COALESCE(hidden_at, now())` to `now()` → the **preserves-existing-timestamp** test must fail. (Without this, R2's evidence property is unpinned.)
2. Change `keep_hidden`'s expression to `hidden_at` → the **hides-a-never-hidden-item** test must fail.
3. Move `recordModerationAction` to **before** the `rows[0] === undefined` check → the **no-action-row-for-a-missing-subject** test must fail.
4. Remove the inline `checkOrigin` call from `handleAdminDecision` → `test/route-protection.test.ts` must fail on *"POST /admin/decision — no Origin -> 403"*. ⚠️ **This is the most important mutation in the plan.** Without it the route is CSRF-able by a logged-in moderator's browser, and the failure mode is silent: every other test still passes, because `requireAdmin` returns 401 on an origin-less *unauthenticated* request and nothing else probes the authenticated-but-cross-site case.

If any mutation leaves its test green, stop and report DONE_WITH_CONCERNS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/moderation/decide.ts apps/api/src/routes/admin.ts apps/api/src/routes.ts \
        apps/api/test/admin-decision-route.test.ts apps/api/test/route-protection.test.ts
git commit -F - <<'MSG'
feat(m4): the three content decisions, applied atomically with their audit row

<body>

Co-Authored-By: <your model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ff1aPFmQ3fj9rKHVuN8GSa
MSG
```

---

## Task 2: The author notice — direct email on the `"outbound"` stream

**Files:** create `src/moderation/notify-author.ts`, `test/moderation-notify.test.ts`; modify `src/routes/admin.ts`.

**Interfaces:**
- Consumes: `applyDecision`'s `DecisionResult` (`{ actionId, authorEmail, hidden }`) and `DecisionKind` from Task 1; `postmarkSend(env, msg)` from `src/auth/postmark.ts` where `msg` carries `{ from, to, subject, textBody, htmlBody, stream }`.
- Produces: `sendModerationNotice(env: Env, to: string, decision: DecisionKind, reason: string): Promise<void>` — never throws.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/moderation-notify.test.ts`. Stub Postmark the way `test/email-drain.test.ts` or the verification-email tests do (read whichever exists and follow it). Assert:

```ts
  it("sends on the OUTBOUND stream, not broadcast", async () => {
    // ⚠️ Broadcast carries one-click unsubscribe headers. A due-process notice
    // is not marketing and must not be unsubscribable (spec §7).
    const sent = await captureSend(() => sendModerationNotice(env, "a@b.test", "remove", "Repeat infringement."));
    expect(sent.stream).toBe("outbound");
  });

  it("puts the statement of reasons in the body", async () => {
    const sent = await captureSend(() => sendModerationNotice(env, "a@b.test", "keep_hidden", "Violates the guidelines."));
    expect(sent.textBody).toContain("Violates the guidelines.");
  });

  it("says something different for a restore than for a removal", async () => {
    const restore = await captureSend(() => sendModerationNotice(env, "a@b.test", "restore", "Mistaken."));
    const remove = await captureSend(() => sendModerationNotice(env, "a@b.test", "remove", "Mistaken."));
    expect(restore.subject).not.toBe(remove.subject);
  });

  // ⚠️ A decision that succeeded in the database must not report failure
  // because Postmark was down.
  it("NEVER THROWS when the send fails", async () => {
    await expect(withFailingPostmark(() =>
      sendModerationNotice(env, "a@b.test", "remove", "x"),
    )).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run it — expect FAIL** (`sendModerationNotice` is not defined).

- [ ] **Step 3: Write the notice**

Create `apps/api/src/moderation/notify-author.ts`:

```ts
/**
 * Tell an author their content was actioned (spec §7).
 *
 * ⚠️ THIS DOES NOT USE THE NOTIFICATION SYSTEM, DELIBERATELY. The `notifications`
 * table demands a human actor, forbids self-addressing, is suppressed by blocks
 * and is silenceable via preferences — all four are wrong for a due-process
 * notice. This sends direct transactional email on the "outbound" stream, the
 * same prefs-bypassing path as `sendVerificationEmail`.
 *
 * ⚠️ NOT the BROADCAST stream: that adds RFC 8058 one-click unsubscribe headers.
 * A user cannot opt out of being told they were actioned. That is correct — it
 * is a safety and due-process notice, not marketing.
 *
 * NEVER THROWS. A decision that already committed must not report failure
 * because Postmark was unreachable; `postmarkSend` logs the status.
 */
import { postmarkSend } from "../auth/postmark";
import { escapeHtml } from "../auth/email-verify";
import type { DecisionKind } from "./decide";

interface Copy {
  readonly subject: string;
  readonly lead: string;
}

const COPY: Readonly<Record<DecisionKind, Copy>> = {
  restore: {
    subject: "Your content has been restored",
    lead: "We reviewed a report about your content and restored it. It is visible again.",
  },
  keep_hidden: {
    subject: "Your content remains hidden after review",
    lead: "We reviewed your content and it remains hidden because it does not meet our Community Guidelines.",
  },
  remove: {
    subject: "Your content has been removed",
    lead: "We reviewed your content and removed it because it does not meet our Community Guidelines.",
  },
};

const APPEAL_URL = "https://community.thinkersjournal.com/appeal";

export async function sendModerationNotice(
  env: Env,
  to: string,
  decision: DecisionKind,
  reason: string,
): Promise<void> {
  const { subject, lead } = COPY[decision];
  const appealLine =
    decision === "restore" ? "" : `\n\nIf you believe this is a mistake, you can appeal: ${APPEAL_URL}`;

  await postmarkSend(env, {
    from: "noreply@thinkersjournal.com",
    to,
    subject,
    textBody: `${lead}\n\nReason given by the reviewer:\n\n${reason}${appealLine}\n`,
    htmlBody:
      `<p>${escapeHtml(lead)}</p><p><strong>Reason given by the reviewer:</strong></p><p>${escapeHtml(reason)}</p>` +
      (decision === "restore"
        ? ""
        : `<p>If you believe this is a mistake, you can <a href="${APPEAL_URL}">appeal</a>.</p>`),
    stream: "outbound",
  });
}
```

⚠️ `escapeHtml` **is** already exported from `src/auth/email-verify.ts` (line 194) — measured, so import it directly. Do not write a second HTML escaper; a second one is a second thing to get wrong.

- [ ] **Step 4: Wire it into the decision route**

In `handleAdminDecision` (Task 1 Step 4), after the `result === null` check and before returning, schedule the notice:

```ts
  // ⚠️ AFTER the commit and OUTSIDE the response path. The decision is already
  // durable; a Postmark outage must not turn a successful moderation action
  // into a 500. See R5.
  ctx.waitUntil(sendModerationNotice(env, result.authorEmail, decision as DecisionKind, reason.trim()));
```

- [ ] **Step 5: Run — expect PASS**, then the full suite and typecheck:

```
pnpm --filter @thinkersjournal/api exec vitest run --project pool test/moderation-notify.test.ts test/admin-decision-route.test.ts
pnpm --filter @thinkersjournal/api exec vitest run
pnpm --filter @thinkersjournal/api run typecheck
```

⚠️ Both. A previous module passed every test and still left the branch red on typecheck.

- [ ] **Step 6: ⚠️ Prove the stream choice is load-bearing**

Change `stream: "outbound"` to `stream: "broadcast"` → the outbound-stream test must fail. Restore and confirm green. Put the output in your report. A notice silently sent on the unsubscribable stream is exactly the defect §7 exists to prevent, and only this mutation shows the test would catch it.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/moderation/notify-author.ts apps/api/src/routes/admin.ts apps/api/test/moderation-notify.test.ts
git commit -F - <<'MSG'
feat(m4): tell the author, on the one channel they cannot unsubscribe from

<body>

Co-Authored-By: <your model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ff1aPFmQ3fj9rKHVuN8GSa
MSG
```

---

## Task 3: Author-facing hidden state

**Files:** modify `packages/shared/src/posts.ts`, `apps/api/src/routes/posts.ts`, `apps/web/src/pages/new-post.astro`; extend `apps/api/test/posts.test.ts` (or the suite that covers `handleGetPost` — find it with `grep -rln "handleGetPost\|/posts/\" apps/api/test`).

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `AuthoredPost.hiddenAt: string | null` for the web editor.

- [ ] **Step 1: Write the failing API test**

Add to the suite covering the author's own post read:

```ts
  it("the author's own read exposes hiddenAt", async () => {
    // ⚠️ Today a hidden post 404s publicly and the author sees no difference
    // beyond "my post disappeared". This is the field that fixes that.
    const { id } = await seedHiddenPostOwnedBy(actor);
    const body = await getOwnPost(actor, id);
    expect(body.hiddenAt).not.toBeNull();
  });

  // CONTROL: without this, "not null" is indistinguishable from the field
  // being hardcoded or every post reading as hidden.
  it("CONTROL: a visible post reads hiddenAt null", async () => {
    const { id } = await seedVisiblePostOwnedBy(actor);
    expect((await getOwnPost(actor, id)).hiddenAt).toBeNull();
  });
```

- [ ] **Step 2: Run it — expect FAIL** (`hiddenAt` is `undefined`).

- [ ] **Step 3: Add the field**

In `packages/shared/src/posts.ts`, extend `AuthoredPost`:

```ts
  updatedAt: string;
  /** Non-null while hidden pending review (M4 §4.4). The author sees this; the public read never returns a hidden post at all. */
  hiddenAt: string | null;
  tags: TagRef[];
```

In `apps/api/src/routes/posts.ts`, add to the author's own `SELECT` (the one already allowlisted in the structural guard):

```sql
                p.updated_at AS "updatedAt", p.hidden_at AS "hiddenAt",
```

⚠️ **Do not change the `WHERE` clause.** The allowlist entry in `test/hidden-at-read-guard.node.test.ts:72` matches on the literal string `FROM posts p WHERE p.id = $1 AND p.author_id = $2`; altering it silently drops the exemption and the guard fails. That is the guard working — fix it by leaving the predicate alone, never by editing the allowlist.

Then **capture the value**, alongside the existing `title` / `markdownSource` / `tagsValue` assignments in `apps/web/src/pages/new-post.astro` (around line 295). ⚠️ **Selecting the column is not enough** — the editor destructures three fields out of `existing.data` and lets the rest go out of scope, so `hiddenAt` is unreachable in the template unless it is bound:

```ts
let hiddenAt: string | null = null;   // declare beside `let title` / `let markdownSource`
```

```ts
    tagsValue = existing.data.tags.map((t) => t.label).join(", ");
    hiddenAt = existing.data.hiddenAt;
```

- [ ] **Step 4: Run — expect PASS**, and run the structural guard too:

```
pnpm --filter @thinkersjournal/api exec vitest run --project node test/hidden-at-read-guard.node.test.ts
pnpm --filter @thinkersjournal/api run typecheck
```

- [ ] **Step 5: Add the editor banner**

⚠️ **There is no `notice` / `alert` / `callout` class in this app** — measured across `apps/web/src/styles` (`global.css`, `tokens.css`), `src/components` and `src/pages`. The file's own outcome messages are bare `<p id="...">` elements (lines 318-322). **Follow that**, and add the one style rule to the `<style>` block this file already has (line 418) rather than inventing a component or a stylesheet:

```astro
    {hiddenAt && (
      <p id="hidden-pending-review" role="status">
        <strong>Hidden pending review.</strong> This post is not visible to others while a
        report about it is reviewed. <a href="/appeal">Appeal this</a>
      </p>
    )}
```

Place it with the other outcome messages (beside `{outcome === "saved" && …}`), and add to the existing `<style>` block:

```css
  #hidden-pending-review {
    border-left: 3px solid var(--color-warning, #b45309);
    padding-left: 0.75rem;
  }
```

⚠️ If `--color-warning` is not defined in `tokens.css`, the fallback in the `var()` covers it — but say in your report whether the token existed, because inventing a token silently is how a design system drifts.

- [ ] **Step 6: Add the web test**

Add to the web suite covering `new-post.astro` (find it: `grep -rln "new-post" apps/web/test apps/web/src`):

```ts
  it("shows the hidden-pending-review banner when hiddenAt is set", async () => {
    const html = await renderEditor({ hiddenAt: "2026-09-11T00:00:00.000Z" });
    expect(html).toContain("Hidden pending review");
  });

  // CONTROL: otherwise the banner could be unconditional and this would pass.
  it("CONTROL: no banner when hiddenAt is null", async () => {
    const html = await renderEditor({ hiddenAt: null });
    expect(html).not.toContain("Hidden pending review");
  });
```

- [ ] **Step 7: Run everything**

```
pnpm --filter @thinkersjournal/api exec vitest run
pnpm --filter @thinkersjournal/api run typecheck
pnpm --filter @thinkersjournal/web test
pnpm --filter @thinkersjournal/web run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/posts.ts apps/api/src/routes/posts.ts apps/api/test \
        apps/web/src/pages/new-post.astro apps/web
git commit -F - <<'MSG'
feat(m4): the author can see their own post is hidden pending review

<body>

Co-Authored-By: <your model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ff1aPFmQ3fj9rKHVuN8GSa
MSG
```

---

## Carried forward — NOT in this module

- **Account actions** (warn / suspend / ban) are module **2c** (decision #3). The columns exist (issue #35, migration 0015) and `isBarred` refuses them at login; nothing writes them yet.
- ⚠️ **Whatever first writes those columns must bump `security_epoch` in the same operation** — the column bars re-entry, the epoch kills live sessions, and neither alone is a ban. Recorded in the spec at `:174`, `:332`, `:335`.
- **The mutating pipeline does not yet refuse a barred user** — [issue #50](https://github.com/ThinkersJournal/community/issues/50), with the fix written out.
- **`/appeal`** is linked from the notice and the banner but is **not built here** — spec §6 puts the in-app appeal form in a later slice. ⚠️ **If that route does not exist when this ships, the link is a 404 and the notice promises something the product does not have.** Either land a stub page in Task 3 or file it before merge; do not ship a dead appeal link. Say which you did in your report.

## Self-Review

**Spec coverage:** §4.3 three decisions → Task 1. §4.4 author-facing hidden state → Task 3. §7 prefs-bypassing notice → Task 2.

**AC-5 (no second visibility predicate) → held by construction, and NOT by an automated guard.** `hidden_at` is the only visibility column anywhere in this plan; nothing adds a second. ⚠️ **Be precise about what backstops it: nothing automated does.** The `hidden-at-read-guard` cannot see `decide.ts` at all — it scans `src/routes/**` and this file is in `src/moderation/`, and even placed inside that tree its query would be invisible, because the table is a template interpolation (`${table}`) rather than a literal and the UPDATE *target* is outside what the scanner examines. So AC-5 here rests on review and on `decide.ts`'s header, which is why that header states the reasoning rather than merely asserting the rule. **An earlier draft of this sentence claimed a guard entry and a mutation proving "the guard sees the new write" — both were false, and the claim survived two rounds of edits to the steps it described.**

**Placeholders:** none. Three places deliberately say "read the existing file and follow its pattern" (the Access-header harness, the Postmark stub, the editor's notice markup) — those are pattern-matching against real files named by path, not unresolved values.

**Type consistency:** `DecisionKind` is defined in `decide.ts` (Task 1) and imported by `notify-author.ts` (Task 2) and the route. `DecisionResult.authorEmail` is produced in Task 1 Step 3 and consumed in Task 2 Step 4. `AuthoredPost.hiddenAt` is added in Task 3 Step 3 and read in Step 5.

⚠️ **Validated before this plan was handed to anyone** — not before it was written, which is a distinction worth keeping honest. Four defects reached implementers in module 2a from code handed over as "use this verbatim" without being run.

| block | how |
|---|---|
| the `UPDATE ... FROM users ... RETURNING u.email` in `decide.ts` | **executed against the live schema** in a rolled-back transaction, `psql -e`, output read whole (no filter between the command and the reading of it). All four behaviours confirmed: `RETURNING` reaches the joined table's column; `keep_hidden`'s `COALESCE` **preserved** an existing `hidden_at` byte-for-byte (`2026-09-08 01:10:10.741236+00` before and after); `restore` set NULL; `keep_hidden` on an un-hidden row re-hid it; a missing subject returned `UPDATE 0` with no error. Control: the rollback left no rows behind. |
| `posts` / `comments` column parity | measured — both carry `id`, `author_id`, `hidden_at`, so the one applier genuinely serves both subjects |
| the TypeScript blocks | **extracted into the real paths and compiled** (`pnpm --filter @thinkersjournal/api run typecheck`), with a mutation control per new file proving each was genuinely in the compiled set — a clean run over a file that was never created is not evidence. Web half checked with `astro check`. |
| the plan against the repo | every claimed signature, path and export verified; the harness files it points at confirmed to exist and be reusable |

⚠️ **First run of that script produced NO output and exited 0**, because a `tail` sat between the command and my reading of it — the "a command that never ran looks like a clean result" shape, and the rollback control was consistent with *both* readings. Re-run unfiltered into a file. **Do not read a psql script's result through a filter.**


## What the pre-dispatch audit caught — and why this section exists

The first draft of this plan went to an auditor before any implementer saw it. **Five defects, all confirmed by execution, four of which would have reached an implementer as "use this verbatim":**

1. ⚠️ **A REAL CSRF HOLE.** `handleAdminDecision` had no origin check. `src/admin/require-admin.ts`'s own header — written in module 2a, addressed to whoever added the first non-GET admin route — says that route **must** call `checkOrigin` inline and be added to `PIPELINE_EXEMPT`, because Cloudflare injects the Access assertion from the `CF_Authorization` **cookie**, so a cross-site form post from a logged-in moderator's browser carries a valid one. **The warning was left in the file this plan imports from, and the plan walked past it.** Verified: the route as first written returned 401 (not 403) to an origin-less mutation, and `test/route-protection.test.ts` failed.
2. **`INVALID_BODY` is not in the error vocabulary.** `ApiErrorCode` in `packages/shared/src/errors.ts` is a **closed union**; the real split is `INVALID_JSON` / `INVALID_INPUT`. Two `TS2345`s.
3. **`errorResponse` was used but never imported** into `admin.ts`. Three `TS2304`s.
4. ⚠️ **The `hidden-at-read-guard` allowlist entry would have BROKEN that suite.** The guard scans `src/routes/**` only; `decide.ts` lives in `src/moderation/`, so the entry would match nothing — and the guard has a **stale-exemption check** that fails on exactly that. The plan's mutation step had the direction backwards too. The correct answer, which `queue.ts` already documents, is that no entry is needed.
5. **The editor snippet referenced a variable that does not exist** (`post`), and used a CSS class this app has never defined.

⚠️ **And a sixth, found while fixing the fifth: my correction for #2 committed #2's own error.** The `checkOrigin` block I added to fix the CSRF hole returned `errorResponse("FORBIDDEN_ORIGIN", 403)` — and `FORBIDDEN_ORIGIN` is not in the closed union either. The auditor had predicted exactly this: *"rework on security-relevant test infrastructure is where a fix for one round's finding tends to introduce the next round's."* **Caught by re-checking the new code against the same vocabulary that produced the original finding, rather than assuming a fix inherits correctness from the finding it answers.**

**The re-audit then caught a seventh, and it is the same class as the sixth:** the corrected Step 6 said *"do not add an allowlist entry"* while the **File Structure table and Task 1's own Files: line still said to modify that file** — and the auditor proved that following the table reproduces the original defect exactly (`1 failed | 3 passed`). The Self-Review section likewise still claimed AC-5 was backstopped by "the guard allowlist entry" and a mutation that no longer existed.

**And a FOURTH instance, which I found by grepping my own fix rather than by reading:** the `routes.ts` registration block still carried the comment *"test/hidden-at-read-guard.node.test.ts carries an allowlist entry for it"* — inside a code block an implementer pastes **verbatim into production source**, so the stale claim would have shipped as a comment in `routes.ts` asserting an exemption that must never exist.

⚠️ **A FIX THAT UPDATES THE STEP AND NOT ITS SUMMARY HAS NOT LANDED.** A plan states the same thing in several places — a file table, a task preamble, a step, a self-review — and a reader entering at any of them acts on what they find there. This is the third instance of the class in one workstream: stale step-number cross-references after a renumbering, a ratchet blinded by prose added elsewhere in the same fix wave, and now a corrected step contradicted by its own summary row.

⚠️ **The transferable part: four of the five original defects were invisible to reading and obvious to executing.** The plan's prose was internally coherent in every case — the code simply did not compile, or the guard did not scan where the prose assumed. **A plan that ships code is two artifacts, and the second one is only gated by running it.**
