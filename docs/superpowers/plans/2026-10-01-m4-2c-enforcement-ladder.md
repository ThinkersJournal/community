# M4 2c (plan A) — Enforcement Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a moderator a real, audited way to warn, suspend and ban an account. Each action changes the account's state, kills its live sessions, appends to the moderation log, and tells the user why.

**Architecture:** One primitive, `applyAccountAction`, writes `users` and `moderation_actions` in a single transaction. That primitive also serves the CSAM `terminate` path, which #114 wires later. Two Access-gated admin routes sit on top: read an account's state and history, and take an action. A thin server-rendered admin page sits on those routes, linked from the review queue. The barred user's 403 (shipped in #123) gains the statement of reasons for a suspension or ban.

**Tech Stack:** TypeScript on Cloudflare Workers (`apps/api`), Astro SSR (`apps/web`), Postgres via Hyperdrive (`pg`), vitest (`cloudflare:test` pool project + Node `*.db.test.ts` / `*.node.test.ts` projects), Postmark "outbound" stream.

**Spec:** `docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md`. This plan implements §5 (the ladder), the account half of §3.2, §7 (notices) for account actions, and the §10/§12 conditions that apply to them. Appeals (§6) are **plan B** and DSA intake (§8) is **plan C**, both separate.

**Rulings this plan relies on (PM, 2026-10-01, relaying CireSnave's "build it" on #113):**
- §11.2's proposed defaults are adopted, as named constants: suspension durations 24h / 7d / 30d with 7d the default; actions older than 12 months stop escalating the ladder (they stay in the log permanently).
- `terminate` gets the primitive here, but **no admin button and no email**. It is the CSAM path, owned by #114, and whether a CSAM-terminated user may be told why is an open legal question.
- Barred users get `403 ACCOUNT_BARRED` (#123, merged). Reason text is this plan's job, but **not for terminate**.

## Global Constraints

- TypeScript pinned to **6.0.3**; do not upgrade.
- Every non-2xx api response goes through `errorResponse` (`apps/api/src/http/errors.ts`); codes come from the **closed** `ApiErrorCode` union in `packages/shared/src/errors.ts`, so a new code is added there or it does not compile.
- Admin routes: `checkOrigin` **first**, then `requireAdmin` (`apps/api/src/admin/require-admin.ts`). They never run `runMutatingPipeline`, and each new non-GET admin route is added to `apps/api/test/helpers/pipeline-exempt.ts` with a reason.
- All auth, permission and account-state reads use **`HYPERDRIVE_FRESH`**, never `HYPERDRIVE_CACHED`.
- `moderation_actions` is append-only (DB trigger). Write it only through `recordModerationAction` (`apps/api/src/moderation/actions.ts`).
- Moderation notices are direct transactional email on the Postmark **"outbound"** stream (never the notification system, never "broadcast"), sent via `ctx.waitUntil`, and they **never throw**.
- Soft-disable only: never `DELETE` a `users` row for an account action.
- Spec §0 decision #3: **account actions are never offered on the review-queue decision form.** The queue only *links* to the account page.
- Statement of reasons is required and is shown to the user: `reason.trim() === ""` is invalid input.
- Web admin pages: the Access-JWT-absent guard is the **first** statement (see `apps/web/src/pages/admin/queue.astro`), then `markPrivate`, then `setPublicPageCsp`.
- Repo convention: write "Part of #113" in PR bodies, never a close keyword, until the last of plans A/B/C ships.

## Review Focus

1. **Re-suspending an already-suspended user must never SHORTEN the bar.** A 24h suspension applied during an existing 30-day one must leave the 30-day end in place. Pinned in Task 1 (`GREATEST`).
2. **Acting on an already-disabled account (banned or terminated).** Warn, suspend or ban must refuse with 409 `ACCOUNT_ALREADY_DISABLED` and append no log row. Terminate on a banned account is allowed (it upgrades the reason). Pinned in Task 1 for both a banned and a terminated account.
3. **A login racing the ban.** A login that completes between the moderator's click and the DB commit must not keep a live session. The epoch is bumped **before and after** the commit, which is pinned in Task 4. GET routes do not re-read the bar (`readCurrentSession` checks only the epoch), so the bump is what makes a ban stick on reads.
4. **Handle case.** `profiles.username` is `citext`, so `/admin/accounts/Alice` and `/admin/accounts/alice` are the same account. Pinned in Task 4.
5. **An anonymised (deleted) account.** Its handle is released and its email is scrubbed, so it must 404 by handle, and no notice is ever sent to a scrubbed address. Pinned in Tasks 3 and 4.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/shared/src/admin.ts` (modify) | Wire types + the adopted constants (`ADMIN_ACCOUNT_ACTIONS`, `SUSPENSION_HOURS`, `DEFAULT_SUSPENSION_HOURS`, `ESCALATION_WINDOW_MONTHS`) and `suggestNextRung` (pure, shared so the UI and API agree). |
| `packages/shared/src/errors.ts` (modify) | `ACCOUNT_ALREADY_DISABLED` code; `AccountBarredDetail` gains an optional `reason`. |
| `apps/api/src/moderation/account-actions.ts` (create) | `applyAccountAction`, the one transactional write of an account action, and `loadAccountHistory`. |
| `apps/api/src/moderation/notify-account.ts` (create) | `sendAccountActionNotice`, the warn/suspend/ban email. |
| `apps/api/src/routes/admin-accounts.ts` (create) | `GET /admin/accounts/:handle`, `POST /admin/accounts/:handle/actions`. |
| `apps/api/src/routes.ts` (modify) | Register the two routes. |
| `apps/api/src/auth/account-status.ts` + `auth/pipeline.ts` + `routes/login.ts` (modify) | The 403 carries the latest suspend/ban reason. |
| `apps/api/src/moderation/queue.ts` (modify) | `QueueItem.authorHandle`, so the queue can link to the account page. |
| `apps/web/src/pages/admin/accounts/[handle].astro` (create) | The account page: state, history, suggested rung, the three action forms. |
| `apps/web/src/pages/admin/queue.astro` (modify) | A link per item to its author's account page. **No action buttons.** |
| `apps/web/src/lib/barred-message.ts` (modify) | Show the reason. |
| `docs/legal/community-guidelines.md`, the spec (modify) | Retire the `[[NOT YET TRUE]]` ladder note from #122 for suspend/ban. |

---

### Task 1: The account-action primitive

**Files:**
- Modify: `packages/shared/src/admin.ts` (append), `packages/shared/src/errors.ts`
- Create: `apps/api/src/moderation/account-actions.ts`
- Test: `apps/api/test/account-actions.test.ts` (pool project, **not** a `*.db.test.ts`; see the note in Step 2)

**Interfaces:**
- Produces: `applyAccountAction(c: Client, input: AccountActionInput): Promise<AccountActionOutcome>`, plus the `AccountActionInput`, `AccountActionOutcome` and `AccountActionKind` types (below). Also `SUSPENSION_HOURS`, `DEFAULT_SUSPENSION_HOURS`, `SuspensionHours`, `ADMIN_ACCOUNT_ACTIONS`, `AdminAccountActionKind` from `@thinkersjournal/shared`.

- [ ] **Step 1: Add the shared constants and the error code**

Append to `packages/shared/src/admin.ts`:

```ts
/**
 * #113 plan A — the account actions a moderator can take from the admin UI.
 * ⚠️ `terminate` is deliberately NOT here: it is the CSAM path (#114), which
 * calls the primitive itself and has no admin button.
 */
export const ADMIN_ACCOUNT_ACTIONS = ["warn", "suspend", "ban"] as const;
export type AdminAccountActionKind = (typeof ADMIN_ACCOUNT_ACTIONS)[number];

/** Spec §11.2, adopted by the PM 2026-10-01: 24h / 7d / 30d, default 7d. */
export const SUSPENSION_HOURS = [24, 168, 720] as const;
export type SuspensionHours = (typeof SUSPENSION_HOURS)[number];
export const DEFAULT_SUSPENSION_HOURS: SuspensionHours = 168;

/** Spec §5/§11.2, adopted: an action older than this no longer escalates the ladder (it stays in the log). */
export const ESCALATION_WINDOW_MONTHS = 12;
```

In `packages/shared/src/errors.ts`, add to the `ApiErrorCode` union next to `ACCOUNT_BARRED`:

```ts
  // 409 — #113: a warn/suspend/ban on an account that is already permanently
  // disabled (banned, or terminated on the CSAM path). A second ban would be a
  // log row that changes nothing; a suspension or warning of a disabled account
  // would read as a step DOWN the ladder. "Disabled", not "banned": the code
  // must not tell a moderator a terminated account was merely banned.
  | "ACCOUNT_ALREADY_DISABLED"
```

- [ ] **Step 2: Write the failing DB test**

Create `apps/api/test/account-actions.test.ts`.

⚠️ **It must be a POOL test (`*.test.ts`), not a Node `*.db.test.ts`.** `account-actions.ts` imports `BEGIN_BOUNDED_TX` from `src/db/client.ts`. That module's `withClient` signature names the ambient Worker types `Hyperdrive` and `ExecutionContext`, which only the pool project's tsconfig (`test/tsconfig.json`, via `worker-configuration.d.ts`) declares. A `*.db.test.ts` is typechecked by `test/tsconfig.node.json` (`"types": ["node"]`), and there `pnpm typecheck` fails with `TS2304: Cannot find name 'Hyperdrive'` (reproduced by the plan audit). `decide.ts`, which has the same import, is tested the same way: through pool tests.

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import { applyAccountAction } from "../src/moderation/account-actions";

/**
 * #113 plan A, Task 1 — the account-action primitive (spec §5). Pool project:
 * real workerd + the test DB through HYPERDRIVE_FRESH, same as the route tests.
 */
const madeUsers: string[] = [];

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

afterEach(async () => {
  // moderation_actions has no FKs and is append-only: its rows stay, by design.
  if (madeUsers.length > 0) await ctxRun((c) => c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]));
  madeUsers.length = 0;
});

async function mkUser(): Promise<string> {
  const id = crypto.randomUUID();
  await ctxRun((c) =>
    c.query(`INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, 'h', now())`, [id, `${id}@accounts.test`]),
  );
  madeUsers.push(id);
  return id;
}

async function status(id: string) {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ suspended_until: Date | null; disabled_at: Date | null; disabled_reason: string | null }>(
      `SELECT suspended_until, disabled_at, disabled_reason FROM users WHERE id = $1`, [id],
    );
    return rows[0]!;
  });
}

async function actionsFor(id: string) {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ action: string; reason: string; action_expires_at: Date | null }>(
      `SELECT action, reason, action_expires_at FROM moderation_actions WHERE subject_user_id = $1 ORDER BY created_at`, [id],
    );
    return rows;
  });
}

/** Run the primitive on its own connection, as a route would. */
function apply(input: Parameters<typeof applyAccountAction>[1]) {
  return ctxRun((c) => applyAccountAction(c, input));
}

const base = { actorAdmin: "mod@example.test", subjectLabel: "someone" } as const;

describe("applyAccountAction", () => {
  it("warn: appends a user_warn row and changes no account state", async () => {
    const u = await mkUser();
    const out = await apply({ ...base, userId: u, kind: "warn", reason: "be kind" });
    expect(out.kind).toBe("applied");
    expect(await status(u)).toEqual({ suspended_until: null, disabled_at: null, disabled_reason: null });
    expect((await actionsFor(u)).map((a) => a.action)).toEqual(["user_warn"]);
  });

  it("suspend: sets suspended_until ≈ now + hours, and records the same end on the action", async () => {
    const u = await mkUser();
    const before = Date.now();
    const out = await apply({ ...base, userId: u, kind: "suspend", reason: "cool off", suspensionHours: 24 });
    expect(out.kind).toBe("applied");
    const s = await status(u);
    expect(s.suspended_until).not.toBeNull();
    const end = s.suspended_until!.getTime();
    expect(end).toBeGreaterThanOrEqual(before + 24 * 3600_000 - 5_000);
    expect(end).toBeLessThanOrEqual(Date.now() + 24 * 3600_000 + 5_000);
    const [a] = await actionsFor(u);
    expect(a!.action).toBe("user_suspend");
    expect(a!.action_expires_at!.getTime()).toBe(end);
  });

  it("⚠️ Review Focus 1: a shorter suspension never SHORTENS an existing longer one", async () => {
    const u = await mkUser();
    await apply({ ...base, userId: u, kind: "suspend", reason: "long", suspensionHours: 720 });
    const long = (await status(u)).suspended_until!.getTime();
    await apply({ ...base, userId: u, kind: "suspend", reason: "short", suspensionHours: 24 });
    expect((await status(u)).suspended_until!.getTime()).toBe(long);
    // The log still records what the moderator asked for, and the effective end it produced.
    const rows = await actionsFor(u);
    expect(rows.map((r) => r.action)).toEqual(["user_suspend", "user_suspend"]);
    expect(rows[1]!.action_expires_at!.getTime()).toBe(long);
  });

  it("ban: sets disabled_at and disabled_reason = 'ban'", async () => {
    const u = await mkUser();
    expect((await apply({ ...base, userId: u, kind: "ban", reason: "done" })).kind).toBe("applied");
    const s = await status(u);
    expect(s.disabled_at).not.toBeNull();
    expect(s.disabled_reason).toBe("ban");
  });

  it("⚠️ Review Focus 2: warn/suspend/ban on a BANNED account is refused and writes NO log row", async () => {
    const u = await mkUser();
    await apply({ ...base, userId: u, kind: "ban", reason: "first" });
    for (const kind of ["warn", "suspend", "ban"] as const) {
      const out = await apply({ ...base, userId: u, kind, reason: "again", suspensionHours: 24 });
      expect(out).toEqual({ kind: "already_disabled" });
    }
    expect((await actionsFor(u)).map((a) => a.action)).toEqual(["user_ban"]);
  });

  it("warn/suspend/ban on a TERMINATED account is refused the same way (already_disabled), with no log row", async () => {
    const u = await mkUser();
    await apply({ ...base, userId: u, kind: "terminate", reason: "csam" });
    for (const kind of ["warn", "suspend", "ban"] as const) {
      expect(await apply({ ...base, userId: u, kind, reason: "again", suspensionHours: 24 })).toEqual({ kind: "already_disabled" });
    }
    expect((await actionsFor(u)).map((a) => a.action)).toEqual(["user_terminate"]);
  });

  it("terminate: allowed on a banned account; keeps the ORIGINAL disabled_at, upgrades the reason", async () => {
    const u = await mkUser();
    await apply({ ...base, userId: u, kind: "ban", reason: "first" });
    const bannedAt = (await status(u)).disabled_at!.getTime();
    expect((await apply({ ...base, userId: u, kind: "terminate", reason: "csam" })).kind).toBe("applied");
    const s = await status(u);
    expect(s.disabled_at!.getTime()).toBe(bannedAt);
    expect(s.disabled_reason).toBe("terminate");
  });

  it("a nonexistent user is not_found and writes no log row", async () => {
    const ghost = crypto.randomUUID();
    expect(await apply({ ...base, userId: ghost, kind: "warn", reason: "x" })).toEqual({ kind: "not_found" });
    expect(await actionsFor(ghost)).toEqual([]);
  });

  it("the state change and the log row commit together: a log failure leaves the account untouched", async () => {
    const u = await mkUser();
    // An over-long violation_category violates moderation_actions' CHECK, so the INSERT fails AFTER the UPDATE.
    await expect(
      apply({ ...base, userId: u, kind: "ban", reason: "x", violationCategory: "not-a-category" as never }),
    ).rejects.toThrow(/violation_category/);
    expect(await status(u)).toEqual({ suspended_until: null, disabled_at: null, disabled_reason: null });
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd apps/api && npx vitest run test/account-actions.test.ts`
Expected: FAIL. The file cannot resolve `../src/moderation/account-actions`.

- [ ] **Step 4: Implement the primitive**

Create `apps/api/src/moderation/account-actions.ts`:

```ts
/**
 * THE ONE WAY an account action is applied (spec §5, #113 plan A).
 *
 * ⚠️ THE ACCOUNT-STATE WRITE AND THE AUDIT APPEND SHARE ONE TRANSACTION —
 * the same rule as decide.ts. A ban with no log row is unexplainable; a log
 * row with no ban is a lie.
 *
 * ⚠️ THIS DOES NOT BUMP THE SECURITY EPOCH. It takes a pg Client and cannot
 * reach the Durable Object; the route does it, before AND after this commits
 * (routes/admin-accounts.ts). A caller that skips the bump leaves the user's
 * live sessions reading (GETs check only the epoch).
 *
 * Takes the caller's `pg.Client` and never opens its own connection, matching
 * decide.ts / actions.ts.
 */
import type { Client } from "pg";

import { BEGIN_BOUNDED_TX } from "../db/client";
import { recordModerationAction, type ModerationActionKind, type ViolationCategory } from "./actions";

import type { SuspensionHours } from "@thinkersjournal/shared";

export type AccountActionKind = "warn" | "suspend" | "ban" | "terminate";

export interface AccountActionInput {
  readonly userId: string;
  readonly kind: AccountActionKind;
  /** The statement of reasons (DSA). Shown to the user. */
  readonly reason: string;
  /** Access identity (email) of the acting human. */
  readonly actorAdmin: string;
  /** Denormalized identity for the log (the handle at action time). */
  readonly subjectLabel: string;
  /** Required for `suspend`; ignored otherwise. */
  readonly suspensionHours?: SuspensionHours;
  readonly violationCategory?: ViolationCategory;
  readonly internalNote?: string;
}

export type AccountActionOutcome =
  | { readonly kind: "applied"; readonly actionId: string; readonly email: string; readonly anonymised: boolean; readonly suspendedUntil: Date | null }
  | { readonly kind: "already_disabled" }
  | { readonly kind: "not_found" };

const LOG_ACTION: Readonly<Record<AccountActionKind, ModerationActionKind>> = {
  warn: "user_warn",
  suspend: "user_suspend",
  ban: "user_ban",
  terminate: "user_terminate",
};

/**
 * ⚠️ `GREATEST(...)` FOR suspend (Review Focus 1): a new suspension never
 * SHORTENS an existing one. ⚠️ `COALESCE(disabled_at, now())` for terminate:
 * terminating an already-banned account keeps the ORIGINAL ban time, which is
 * evidence of when the account was barred.
 */
const SET_SQL: Readonly<Record<AccountActionKind, string>> = {
  warn: "",
  suspend: "suspended_until = GREATEST(COALESCE(u.suspended_until, now()), now() + make_interval(hours => $2::int))",
  ban: "disabled_at = now(), disabled_reason = 'ban'",
  terminate: "disabled_at = COALESCE(u.disabled_at, now()), disabled_reason = 'terminate'",
};

export async function applyAccountAction(c: Client, input: AccountActionInput): Promise<AccountActionOutcome> {
  if (input.kind === "suspend" && input.suspensionHours === undefined) {
    throw new Error("applyAccountAction: suspend requires suspensionHours");
  }
  await c.query(BEGIN_BOUNDED_TX);
  try {
    // Lock the row so two moderators acting at once serialize.
    const { rows } = await c.query<{ email: string; disabled_at: Date | null; anonymised: boolean }>(
      `SELECT email, disabled_at, anonymised_at IS NOT NULL AS anonymised FROM users WHERE id = $1 FOR UPDATE`,
      [input.userId],
    );
    const user = rows[0];
    if (user === undefined) {
      await rollbackQuietly(c);
      return { kind: "not_found" };
    }
    if (user.disabled_at !== null && input.kind !== "terminate") {
      await rollbackQuietly(c);
      return { kind: "already_disabled" };
    }

    let suspendedUntil: Date | null = null;
    if (input.kind !== "warn") {
      const params: unknown[] = input.kind === "suspend" ? [input.userId, input.suspensionHours] : [input.userId];
      const { rows: updated } = await c.query<{ suspended_until: Date | null }>(
        `UPDATE users AS u SET ${SET_SQL[input.kind]} WHERE u.id = $1 RETURNING u.suspended_until`,
        params,
      );
      suspendedUntil = input.kind === "suspend" ? (updated[0]?.suspended_until ?? null) : null;
    }

    const actionId = await recordModerationAction(c, {
      actorAdmin: input.actorAdmin,
      action: LOG_ACTION[input.kind],
      reason: input.reason,
      subjectUserId: input.userId,
      subjectLabel: input.subjectLabel,
      violationCategory: input.violationCategory,
      actionExpiresAt: suspendedUntil ?? undefined,
      internalNote: input.internalNote,
    });

    await c.query("COMMIT");
    return { kind: "applied", actionId, email: user.email, anonymised: user.anonymised, suspendedUntil };
  } catch (err) {
    // Same reasoning as decide.ts: a failed ROLLBACK must not replace the root error.
    await rollbackQuietly(c);
    throw err;
  }
}

async function rollbackQuietly(c: Client): Promise<void> {
  try {
    await c.query("ROLLBACK");
  } catch {
    // Deliberately swallowed — see decide.ts.
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd apps/api && npx vitest run test/account-actions.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Prove two guards can fail (mutation)**

Temporarily change `GREATEST(COALESCE(u.suspended_until, now()), now() + make_interval(hours => $2::int))` to `now() + make_interval(hours => $2::int)`, then run the test. Expected: "Review Focus 1" FAILS. Restore it.
Temporarily delete the `if (user.disabled_at !== null && input.kind !== "terminate")` block, then run. Expected: "Review Focus 2" FAILS. Restore it.

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm typecheck`. Expected: clean.

```bash
git add packages/shared/src/admin.ts packages/shared/src/errors.ts apps/api/src/moderation/account-actions.ts apps/api/test/account-actions.test.ts
git commit -m "feat(moderation): the account-action primitive — warn/suspend/ban/terminate in one transaction (Part of #113)"
```

---

### Task 2: History and the suggested rung

**Files:**
- Modify: `packages/shared/src/admin.ts` (append), `apps/api/src/moderation/account-actions.ts` (append)
- Test: `packages/shared/test/admin-ladder.test.ts`, `apps/api/test/account-actions.test.ts` (append)

**Interfaces:**
- Consumes: `ESCALATION_WINDOW_MONTHS`, `AdminAccountActionKind` (Task 1).
- Produces: `suggestNextRung(history: readonly LadderEntry[]): AdminAccountActionKind`, `LadderEntry`, `AdminAccountHistoryEntry` (shared); `loadAccountHistory(c: Client, userId: string): Promise<AdminAccountHistoryEntry[]>` (api).

- [ ] **Step 1: Write the failing shared test**

Create `packages/shared/test/admin-ladder.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { suggestNextRung } from "../src";

/**
 * Spec §5: warn → suspend → ban, "proportionate to severity and history". The
 * suggestion is ADVISORY (a severe violation skips the ladder; the moderator
 * picks), so this only says where history alone points.
 */
const e = (action: "user_warn" | "user_suspend" | "user_ban" | "user_terminate", counts = true) => ({
  action,
  countsTowardEscalation: counts,
});

describe("suggestNextRung", () => {
  it("no history → warn", () => expect(suggestNextRung([])).toBe("warn"));
  it("a counted warning → suspend", () => expect(suggestNextRung([e("user_warn")])).toBe("suspend"));
  it("a counted suspension → ban", () => expect(suggestNextRung([e("user_warn"), e("user_suspend")])).toBe("ban"));
  it("history older than the window does not escalate", () =>
    expect(suggestNextRung([e("user_warn", false), e("user_suspend", false)])).toBe("warn"));
  it("a suspension outside the window but a warning inside → suspend", () =>
    expect(suggestNextRung([e("user_suspend", false), e("user_warn")])).toBe("suspend"));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/shared && npx vitest run test/admin-ladder.test.ts`
Expected: FAIL, `suggestNextRung` is not exported.

- [ ] **Step 3: Implement it in shared**

Append to `packages/shared/src/admin.ts`:

```ts
/** A moderation-log row as the ladder sees it. */
export interface LadderEntry {
  readonly action: "user_warn" | "user_suspend" | "user_ban" | "user_terminate";
  /** False once the row is older than ESCALATION_WINDOW_MONTHS (it stays in the log). */
  readonly countsTowardEscalation: boolean;
}

/** A row in `GET /admin/accounts/:handle`'s history, newest first. */
export interface AdminAccountHistoryEntry extends LadderEntry {
  readonly id: string;
  readonly reason: string;
  readonly violationCategory: string | null;
  readonly actorAdmin: string;
  readonly createdAt: string;
  readonly actionExpiresAt: string | null;
}

/**
 * Where history alone points on the ladder (spec §5). ADVISORY: the moderator
 * decides, and a severe violation skips straight to ban. Shared so the admin
 * page and the api can never disagree about it.
 */
export function suggestNextRung(history: readonly LadderEntry[]): AdminAccountActionKind {
  const counted = history.filter((h) => h.countsTowardEscalation);
  if (counted.some((h) => h.action === "user_suspend" || h.action === "user_ban" || h.action === "user_terminate")) {
    return "ban";
  }
  if (counted.some((h) => h.action === "user_warn")) return "suspend";
  return "warn";
}

/** `GET /admin/accounts/:handle`. */
export interface AdminAccountResponse {
  readonly userId: string;
  readonly handle: string;
  readonly suspendedUntil: string | null;
  readonly disabledAt: string | null;
  readonly history: readonly AdminAccountHistoryEntry[];
  readonly suggestedNext: AdminAccountActionKind;
}

/** `POST /admin/accounts/:handle/actions`. */
export interface AdminAccountActionRequest {
  readonly action: AdminAccountActionKind;
  readonly reason: string;
  readonly violationCategory?: string;
  /** Only for `suspend`; must be one of SUSPENSION_HOURS. Defaults to DEFAULT_SUSPENSION_HOURS. */
  readonly suspensionHours?: number;
}
```

- [ ] **Step 4: Write the failing DB test for `loadAccountHistory`**

Append to `apps/api/test/account-actions.test.ts` (and add `loadAccountHistory` to its import):

```ts
describe("loadAccountHistory", () => {
  it("lists only user_* actions for that user, newest first, flagging those inside the 12-month window", async () => {
    const u = await mkUser();
    await ctxRun((c) => c.query(
      `INSERT INTO moderation_actions (actor_admin, action, subject_user_id, reason, created_at)
       VALUES ('m', 'user_warn', $1, 'old', now() - interval '13 months'),
              ('m', 'user_warn', $1, 'recent', now() - interval '1 day'),
              ('m', 'content_remove', $1, 'not an account action', now())`,
      [u],
    ));
    const h = await ctxRun((c) => loadAccountHistory(c, u));
    expect(h.map((x) => [x.reason, x.countsTowardEscalation])).toEqual([
      ["recent", true],
      ["old", false],
    ]);
  });
});
```

- [ ] **Step 5: Implement `loadAccountHistory`**

Append to `apps/api/src/moderation/account-actions.ts` (and add `ESCALATION_WINDOW_MONTHS` and `AdminAccountHistoryEntry` to the shared import):

```ts
/**
 * Every account action against `userId`, newest first. Content actions are
 * excluded: the ladder is about the ACCOUNT (spec §5, decision #3).
 */
export async function loadAccountHistory(c: Client, userId: string): Promise<AdminAccountHistoryEntry[]> {
  const { rows } = await c.query<{
    id: string;
    action: AdminAccountHistoryEntry["action"];
    reason: string;
    violation_category: string | null;
    actor_admin: string;
    created_at: Date;
    action_expires_at: Date | null;
    counts: boolean;
  }>(
    `SELECT id, action, reason, violation_category, actor_admin, created_at, action_expires_at,
            created_at > now() - make_interval(months => $2::int) AS counts
       FROM moderation_actions
      WHERE subject_user_id = $1
        AND action IN ('user_warn','user_suspend','user_ban','user_terminate')
      ORDER BY created_at DESC`,
    [userId, ESCALATION_WINDOW_MONTHS],
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    reason: r.reason,
    violationCategory: r.violation_category,
    actorAdmin: r.actor_admin,
    createdAt: r.created_at.toISOString(),
    actionExpiresAt: r.action_expires_at?.toISOString() ?? null,
    countsTowardEscalation: r.counts,
  }));
}
```

- [ ] **Step 6: Run both tests**

Run: `cd packages/shared && npx vitest run test/admin-ladder.test.ts && cd ../../apps/api && npx vitest run test/account-actions.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/admin.ts packages/shared/test/admin-ladder.test.ts apps/api/src/moderation/account-actions.ts apps/api/test/account-actions.test.ts
git commit -m "feat(moderation): account history and the advisory next rung (Part of #113)"
```

---

### Task 3: The account-action notice

**Files:**
- Create: `apps/api/src/moderation/notify-account.ts`
- Test: `apps/api/test/notify-account.test.ts`

**Interfaces:**
- Produces: `sendAccountActionNotice(env: Env, to: string, notice: AccountNotice): Promise<boolean>`, where `AccountNotice = { kind: "warn" | "suspend" | "ban"; reason: string; suspendedUntil?: Date }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/notify-account.test.ts`. It uses the same Postmark-capture idiom as `test/moderation-notify.test.ts`, stubbing global `fetch` and capturing the body sent to `https://api.postmarkapp.com/email`:

```ts
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendAccountActionNotice } from "../src/moderation/notify-account";

let sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.postmarkapp.com/email") {
        sent.push(JSON.parse(init!.body as string) as Record<string, unknown>);
        return new Response(JSON.stringify({ ErrorCode: 0 }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("sendAccountActionNotice", () => {
  it("warn: says it is a warning and carries the reason, on the outbound stream", async () => {
    expect(await sendAccountActionNotice(env, "u@example.test", { kind: "warn", reason: "be <kind>" })).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.MessageStream).toBe("outbound");
    expect(sent[0]!.Subject).toBe("A warning about your account");
    expect(String(sent[0]!.TextBody)).toContain("be <kind>");
    expect(String(sent[0]!.HtmlBody)).toContain("be &lt;kind&gt;");
  });

  it("suspend: names the end date in UTC", async () => {
    await sendAccountActionNotice(env, "u@example.test", {
      kind: "suspend",
      reason: "r",
      suspendedUntil: new Date("2026-10-08T04:00:00.000Z"),
    });
    expect(String(sent[0]!.TextBody)).toContain("Thu, 08 Oct 2026 04:00:00 GMT");
  });

  it("ban: says the account is banned", async () => {
    await sendAccountActionNotice(env, "u@example.test", { kind: "ban", reason: "r" });
    expect(sent[0]!.Subject).toBe("Your account has been banned");
  });

  it("never throws when Postmark is down — returns false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(sendAccountActionNotice(env, "u@example.test", { kind: "warn", reason: "r" })).resolves.toBe(false);
  });
});
```

Verified at ca8b192: `postmarkSend` (`apps/api/src/auth/postmark.ts:50-53`) serializes `Subject`, `TextBody`, `HtmlBody` and `MessageStream`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/api && npx vitest run test/notify-account.test.ts`
Expected: FAIL, the module cannot be resolved.

- [ ] **Step 3: Implement it**

Create `apps/api/src/moderation/notify-account.ts`:

```ts
/**
 * Tell a user an action was taken on their ACCOUNT (spec §5, §7).
 *
 * Same transport and the same reasons as notify-author.ts: direct
 * transactional email on the "outbound" stream, bypassing notification
 * preferences, because a user cannot opt out of being told they were actioned.
 * NEVER THROWS.
 *
 * ⚠️ NO `terminate` NOTICE. Whether a CSAM-terminated user may be told why is
 * an open legal question (#114), so the type does not admit it.
 * ⚠️ NO APPEAL LINK YET — plan B adds the per-purpose appeal token. A dead
 * link is worse than none (same reasoning as notify-author.ts).
 */
import { postmarkSend } from "../auth/postmark";
import { escapeHtml } from "../auth/email-verify";

export interface AccountNotice {
  readonly kind: "warn" | "suspend" | "ban";
  readonly reason: string;
  /** Required for `suspend`. */
  readonly suspendedUntil?: Date;
}

const SUBJECT: Readonly<Record<AccountNotice["kind"], string>> = {
  warn: "A warning about your account",
  suspend: "Your account has been suspended",
  ban: "Your account has been banned",
};

function lead(notice: AccountNotice): string {
  switch (notice.kind) {
    case "warn":
      return "A moderator has issued a warning on your account for breaking our Community Guidelines. Your account is not restricted.";
    case "suspend":
      return `Your account has been suspended for breaking our Community Guidelines. You will not be able to sign in until ${notice.suspendedUntil?.toUTCString() ?? "the suspension ends"}.`;
    case "ban":
      return "Your account has been permanently banned for breaking our Community Guidelines. You will not be able to sign in again.";
  }
}

export async function sendAccountActionNotice(env: Env, to: string, notice: AccountNotice): Promise<boolean> {
  try {
    const text = lead(notice);
    return await postmarkSend(env, {
      from: "noreply@thinkersjournal.com",
      to,
      subject: SUBJECT[notice.kind],
      textBody: `${text}\n\nReason given by the moderator:\n\n${notice.reason}\n`,
      htmlBody: `<p>${escapeHtml(text)}</p><p><strong>Reason given by the moderator:</strong></p><p>${escapeHtml(notice.reason)}</p>`,
      stream: "outbound",
    });
  } catch (err) {
    console.error("account notice threw", err);
    return false;
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd apps/api && npx vitest run test/notify-account.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/moderation/notify-account.ts apps/api/test/notify-account.test.ts
git commit -m "feat(moderation): the warn/suspend/ban notice (Part of #113)"
```

---

### Task 4: The admin account routes

**Files:**
- Create: `apps/api/src/routes/admin-accounts.ts`
- Modify: `apps/api/src/routes.ts`, `apps/api/test/helpers/pipeline-exempt.ts`
- Test: `apps/api/test/admin-accounts-route.test.ts`

**Interfaces:**
- Consumes: `applyAccountAction`, `loadAccountHistory` (Tasks 1–2), `sendAccountActionNotice` (Task 3), `suggestNextRung`, `ADMIN_ACCOUNT_ACTIONS`, `SUSPENSION_HOURS`, `DEFAULT_SUSPENSION_HOURS`, `REPORT_REASONS` (shared).
- Produces: `handleAdminGetAccount(request, env, ctx, params)` and `handleAdminAccountAction(request, env, ctx, params)`; routes `GET /admin/accounts/:handle` and `POST /admin/accounts/:handle/actions`.

- [ ] **Step 1: Write the failing route test**

Create `apps/api/test/admin-accounts-route.test.ts`. Copy the JWT harness from `apps/api/test/admin-decision-route.test.ts` **by symbol, not by line number** (its line numbers have already moved):
- from the top of the file: its imports, the `TEAM`/`AUD`/`KID` constants, `b64url`, `b64urlJson`, **all five** module-scope `let` declarations (`keyPair`, `sentEmails`, `capturedPurges`, `createdUserIds`, `adminEmail`; lines 19–23 at ca8b192), `makeJwt`, `ctxRun` and `call`. The `beforeEach` below assigns all five, so a missing declaration is a `TS2304` (the plan re-audit reproduced this);
- **and** its module-level `beforeEach`/`afterEach` pair, which sits after the helpers (around line 218 at ca8b192). The `beforeEach` generates `keyPair`, sets `adminEmail`, stubs `fetch` for the JWKS and Postmark endpoints, and calls `__resetJwksCacheForTests()`; the `afterEach` restores globals and deletes `createdUserIds`. Without that pair, every test in the new file fails on an unassigned `keyPair` or an unverifiable JWT.

Keep the stub shapes exactly. Then add:

```ts
const ALLOWED_ORIGIN = "http://localhost:8787";

async function seedHandle(): Promise<{ userId: string; handle: string; email: string }> {
  return ctxRun(async (c) => {
    const handle = `acct${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const email = `${handle}@example.test`;
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, 'x', now()) RETURNING id`, [email]);
    await c.query(`INSERT INTO profiles (user_id, username) VALUES ($1, $2)`, [rows[0]!.id, handle]);
    createdUserIds.push(rows[0]!.id);
    return { userId: rows[0]!.id, handle, email };
  });
}

async function act(handle: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return call(`/admin/accounts/${handle}/actions`, {
    method: "POST",
    headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", "Cf-Access-Jwt-Assertion": await makeJwt(), ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /admin/accounts/:handle/actions", () => {
  it("403s a cross-site origin BEFORE the Access check", async () => {
    const { handle } = await seedHandle();
    const res = await act(handle, { action: "warn", reason: "r" }, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("401s without an Access assertion, and a member session grants nothing", async () => {
    const { handle } = await seedHandle();
    const res = await call(`/admin/accounts/${handle}/actions`, {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ action: "warn", reason: "r" }),
    });
    expect(res.status).toBe(401);
  });

  it.each([
    [{ action: "terminate", reason: "r" }],
    [{ action: "warn", reason: "   " }],
    [{ action: "suspend", reason: "r", suspensionHours: 48 }],
    [{ action: "warn", reason: "r", violationCategory: "nonsense" }],
  ])("400 INVALID_INPUT for %j", async (body) => {
    const { handle } = await seedHandle();
    const res = await act(handle, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it("⚠️ Review Focus 4: the handle is case-insensitive", async () => {
    const { handle, userId } = await seedHandle();
    const res = await act(handle.toUpperCase(), { action: "warn", reason: "r" });
    expect(res.status).toBe(200);
    const rows = await ctxRun((c) => c.query(`SELECT 1 FROM moderation_actions WHERE subject_user_id = $1 AND action = 'user_warn'`, [userId]));
    expect(rows.rowCount).toBe(1);
  });

  it("suspend defaults to 7 days and kills live sessions (the epoch moves)", async () => {
    const { handle, userId } = await seedHandle();
    const before = await env.USER_SECURITY.getByName(userId).getEpoch();
    const res = await act(handle, { action: "suspend", reason: "r" });
    expect(res.status).toBe(200);
    const until = await ctxRun(async (c) => (await c.query<{ s: Date }>(`SELECT suspended_until AS s FROM users WHERE id = $1`, [userId])).rows[0]!.s);
    expect(Math.abs(until.getTime() - (Date.now() + 168 * 3600_000))).toBeLessThan(60_000);
    expect(await env.USER_SECURITY.getByName(userId).getEpoch()).toBeGreaterThan(before);
  });

  it("⚠️ Review Focus 3: the epoch is bumped BEFORE the commit as well as after (two increments)", async () => {
    const { handle, userId } = await seedHandle();
    const before = await env.USER_SECURITY.getByName(userId).getEpoch();
    await act(handle, { action: "ban", reason: "r" });
    expect(await env.USER_SECURITY.getByName(userId).getEpoch()).toBe(before + 2);
  });

  it("warn does NOT touch the epoch", async () => {
    const { handle, userId } = await seedHandle();
    const before = await env.USER_SECURITY.getByName(userId).getEpoch();
    await act(handle, { action: "warn", reason: "r" });
    expect(await env.USER_SECURITY.getByName(userId).getEpoch()).toBe(before);
  });

  it("409 ACCOUNT_ALREADY_DISABLED on a second ban", async () => {
    const { handle } = await seedHandle();
    expect((await act(handle, { action: "ban", reason: "r" })).status).toBe(200);
    const res = await act(handle, { action: "ban", reason: "again" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("ACCOUNT_ALREADY_DISABLED");
  });

  it("404 for an unknown handle", async () => {
    expect((await act("nobody-at-all-here", { action: "warn", reason: "r" })).status).toBe(404);
  });

  it("⚠️ Review Focus 5: an ANONYMISED account 404s by handle", async () => {
    const { handle, userId } = await seedHandle();
    await ctxRun((c) => c.query(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [userId]));
    expect((await act(handle, { action: "warn", reason: "r" })).status).toBe(404);
  });
});

describe("GET /admin/accounts/:handle", () => {
  it("returns state, history newest-first, and the suggested rung", async () => {
    const { handle } = await seedHandle();
    await act(handle, { action: "warn", reason: "first" });
    const res = await call(`/admin/accounts/${handle}`, { headers: { "Cf-Access-Jwt-Assertion": await makeJwt() } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as import("@thinkersjournal/shared").AdminAccountResponse;
    expect(body.handle).toBe(handle);
    expect(body.history.map((h) => h.reason)).toEqual(["first"]);
    expect(body.suggestedNext).toBe("suspend");
  });

  it("401s without an Access assertion", async () => {
    const { handle } = await seedHandle();
    expect((await call(`/admin/accounts/${handle}`)).status).toBe(401);
  });
});
```

(`createdUserIds` is DECLARED by the copied `let` block and cleaned up by the copied `afterEach`; `seedHandle` below pushes into it.)

Verified at ca8b192: `UserSecurityDO.getEpoch()` exists (`apps/api/src/durable-objects/UserSecurityDO.ts:45`).

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/api && npx vitest run test/admin-accounts-route.test.ts`
Expected: FAIL with 404s, because the routes aren't registered.

- [ ] **Step 3: Implement the routes**

Create `apps/api/src/routes/admin-accounts.ts`:

```ts
/**
 * The account half of the enforcement ladder (spec §5, #113 plan A).
 * Same trust domain and the same inline-checkOrigin shape as routes/admin.ts.
 *
 * ⚠️ NOT reachable from the review queue's decision form (spec decision #3):
 * the queue only links here. Content decision and account action are
 * separate, deliberate steps.
 */
import { checkOrigin } from "../auth/csrf";
import { requireAdmin } from "../admin/require-admin";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import { applyAccountAction, loadAccountHistory } from "../moderation/account-actions";
import { sendAccountActionNotice } from "../moderation/notify-account";

import {
  ADMIN_ACCOUNT_ACTIONS,
  DEFAULT_SUSPENSION_HOURS,
  REPORT_REASONS,
  SUSPENSION_HOURS,
  suggestNextRung,
  type AdminAccountActionKind,
  type AdminAccountResponse,
  type SuspensionHours,
} from "@thinkersjournal/shared";

import type { ViolationCategory } from "../moderation/actions";
import type { RouteParams } from "../routing";

interface AccountRow {
  id: string;
  username: string;
  suspended_until: Date | null;
  disabled_at: Date | null;
}

/** ⚠️ `username` is citext (Review Focus 4). An anonymised account's handle is released, so it 404s (Review Focus 5). */
async function findByHandle(env: Env, ctx: ExecutionContext, handle: string): Promise<AccountRow | null> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<AccountRow>(
      `SELECT u.id, pr.username, u.suspended_until, u.disabled_at
         FROM profiles pr JOIN users u ON u.id = pr.user_id
        WHERE pr.username = $1 AND u.anonymised_at IS NULL`,
      [handle],
    );
    return rows[0] ?? null;
  });
}

export async function handleAdminGetAccount(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const account = await findByHandle(env, ctx, params.handle ?? "");
  if (account === null) return errorResponse("NOT_FOUND", 404);

  const history = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => loadAccountHistory(c, account.id));
  const body: AdminAccountResponse = {
    userId: account.id,
    handle: account.username,
    suspendedUntil: account.suspended_until?.toISOString() ?? null,
    disabledAt: account.disabled_at?.toISOString() ?? null,
    history,
    suggestedNext: suggestNextRung(history),
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

export async function handleAdminAccountAction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
): Promise<Response> {
  // ⚠️ ORIGIN FIRST — see routes/admin.ts handleAdminDecision for why Access alone is not enough.
  if (!checkOrigin(env, request)) return errorResponse("FORBIDDEN", 403);
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return errorResponse("INVALID_INPUT", 400);
  const b = body as Record<string, unknown>;
  const action = b["action"];
  const reason = b["reason"];
  const category = b["violationCategory"];
  const hours = b["suspensionHours"] ?? DEFAULT_SUSPENSION_HOURS;

  if (
    typeof action !== "string" || !(ADMIN_ACCOUNT_ACTIONS as readonly string[]).includes(action) ||
    typeof reason !== "string" || reason.trim() === "" ||
    (category !== undefined && !(REPORT_REASONS as readonly unknown[]).includes(category)) ||
    (action === "suspend" && !(SUSPENSION_HOURS as readonly unknown[]).includes(hours))
  ) {
    return errorResponse("INVALID_INPUT", 400);
  }
  const kind = action as AdminAccountActionKind;

  const account = await findByHandle(env, ctx, params.handle ?? "");
  if (account === null) return errorResponse("NOT_FOUND", 404);

  // ⚠️ Review Focus 3 — THE EPOCH IS BUMPED TWICE for a bar. BEFORE the
  // commit: if the Durable Object is unreachable we fail here with nothing
  // written, and the moderator retries cleanly. AFTER the commit: a login that
  // completed between the first bump and the commit (the DB did not bar it
  // yet) got a session carrying the new epoch, and this kills it. GET routes
  // check only the epoch, so without the bump a ban would not stick on reads.
  const bars = kind === "suspend" || kind === "ban";
  if (bars) await env.USER_SECURITY.getByName(account.id).bumpEpoch();

  const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    applyAccountAction(c, {
      userId: account.id,
      kind,
      reason: reason.trim(),
      actorAdmin: admin.email,
      subjectLabel: account.username,
      suspensionHours: kind === "suspend" ? (hours as SuspensionHours) : undefined,
      violationCategory: category as ViolationCategory | undefined,
    }),
  );
  if (outcome.kind === "not_found") return errorResponse("NOT_FOUND", 404);
  if (outcome.kind === "already_disabled") return errorResponse("ACCOUNT_ALREADY_DISABLED", 409);

  if (bars) {
    try {
      await env.USER_SECURITY.getByName(account.id).bumpEpoch();
    } catch (err) {
      // The action is committed; the first bump already killed every session
      // that existed before it. Only a login inside the race window survives.
      console.error("post-commit epoch bump failed", { actionId: outcome.actionId, err });
    }
  }

  // ⚠️ Review Focus 5 — never mail a scrubbed address.
  if (!outcome.anonymised) {
    ctx.waitUntil(
      sendAccountActionNotice(env, outcome.email, {
        kind,
        reason: reason.trim(),
        suspendedUntil: outcome.suspendedUntil ?? undefined,
      }).then((sent) => {
        if (!sent) console.error("account notice not sent", { actionId: outcome.actionId });
      }),
    );
  }

  return new Response(JSON.stringify({ actionId: outcome.actionId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
```

Register both routes in `apps/api/src/routes.ts`, next to the other admin routes (around the `/admin/backfill-hidden-media` entry):

```ts
  // #113 plan A — the account half of the ladder. Same Access trust domain
  // and inline-checkOrigin shape as /admin/decision. NOT linked from the
  // decision form (spec decision #3); the queue links to the account page.
  { method: "GET", pattern: "/admin/accounts/:handle", handler: handleAdminGetAccount },
  { method: "POST", pattern: "/admin/accounts/:handle/actions", handler: handleAdminAccountAction },
```

Add the import `import { handleAdminAccountAction, handleAdminGetAccount } from "./routes/admin-accounts";` and, in `apps/api/test/helpers/pipeline-exempt.ts`, add `"POST /admin/accounts/:handle/actions",` under the existing admin entries, with a one-line comment: `// #113 — same Access + inline checkOrigin defense as /admin/decision.`

The router exposes `:name` segments as `params.name`. `handleApproveMediaAccess` reads `params.id` the same way.

- [ ] **Step 4: Run the route test and the structural suites**

Run: `cd apps/api && npx vitest run test/admin-accounts-route.test.ts test/route-protection.test.ts test/pipeline-barred.test.ts test/error-envelope.test.ts`
Expected: PASS. `route-protection` holds every new route to the exempt list, which is why Step 3 updates it.

- [ ] **Step 5: Mutation — prove the double bump is tested**

Delete the post-commit `bumpEpoch` block, then run `admin-accounts-route.test.ts`. Expected: "Review Focus 3" FAILS (`before + 1`, not `before + 2`). Restore it.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin-accounts.ts apps/api/src/routes.ts apps/api/test/helpers/pipeline-exempt.ts apps/api/test/admin-accounts-route.test.ts
git commit -m "feat(admin): GET/POST /admin/accounts/:handle — the ladder's api (Part of #113)"
```

---

### Task 5: The barred user is told why

**Files:**
- Modify: `packages/shared/src/errors.ts`, `apps/api/src/auth/account-status.ts`, `apps/api/src/auth/pipeline.ts`, `apps/api/src/routes/login.ts`, `apps/web/src/lib/barred-message.ts`
- Test: `apps/api/test/login-barred.test.ts`, `apps/api/test/pipeline-barred.test.ts`, `apps/web/test/barred-message.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's log rows.
- Produces: `AccountBarredDetail` with an optional `reason?: string`; `loadBarReason(c: Client, userId: string): Promise<string | null>`. `accountBarredResponse(row, headers, reason)` gains a third parameter.

**Rule:** the reason is the newest `user_suspend` row (for a suspension) or the newest `user_ban` row (for a ban). **If the account's `disabled_reason` is `'terminate'`, no reason is sent**, because that is the CSAM path and whether to state it is an open legal question (#114).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/login-barred.test.ts`:

```ts
describe("#113 — the 403 carries the moderator's statement of reasons", () => {
  async function logAction(email: string, action: string, reason: string): Promise<void> {
    await query(
      `INSERT INTO moderation_actions (actor_admin, action, subject_user_id, reason)
       SELECT 'mod@example.test', $2, id, $3 FROM users WHERE email = $1`,
      [email, action, reason],
    );
  }

  it("a ban carries the newest user_ban reason", async () => {
    const email = uniqueEmail();
    await insertUser(email, await hashPassword(VALID_PASSWORD));
    await query(`UPDATE users SET disabled_at = now(), disabled_reason = 'ban' WHERE email = $1`, [email]);
    await logAction(email, "user_ban", "spam, repeatedly");
    const res = await login(email, VALID_PASSWORD);
    expect(await res.json()).toEqual({ code: "ACCOUNT_BARRED", barred: { kind: "banned", reason: "spam, repeatedly" } });
  });

  it("⚠️ a TERMINATED account carries NO reason (#114: open legal question)", async () => {
    const email = uniqueEmail();
    await insertUser(email, await hashPassword(VALID_PASSWORD));
    await query(`UPDATE users SET disabled_at = now(), disabled_reason = 'terminate' WHERE email = $1`, [email]);
    // A prior user_ban row too: without it the loader would find nothing for a
    // disabled account anyway, and this test could not catch the exclusion
    // being removed.
    await logAction(email, "user_ban", "must not be shown either");
    await logAction(email, "user_terminate", "must not be shown");
    const res = await login(email, VALID_PASSWORD);
    expect(await res.json()).toEqual({ code: "ACCOUNT_BARRED", barred: { kind: "banned" } });
  });

  it("a hand-set bar with no log row still answers, without a reason", async () => {
    const email = uniqueEmail();
    await insertUser(email, await hashPassword(VALID_PASSWORD));
    await query(`UPDATE users SET disabled_at = now() WHERE email = $1`, [email]);
    expect(await (await login(email, VALID_PASSWORD)).json()).toEqual({ code: "ACCOUNT_BARRED", barred: { kind: "banned" } });
  });
});
```

Append to `apps/web/test/barred-message.test.ts`:

```ts
describe("#113 — the reason", () => {
  it("is appended when present", () => {
    expect(barredMessage({ code: "ACCOUNT_BARRED", barred: { kind: "banned", reason: "spam" } })).toBe(
      "This account has been banned. Reason given by the moderator: spam",
    );
  });
});
```

- [ ] **Step 2: Run both and confirm they fail**

Run: `cd apps/api && npx vitest run test/login-barred.test.ts` and `cd apps/web && npx vitest run test/barred-message.test.ts`
Expected: the ban-reason test and the web reason test FAIL. The terminate and hand-set tests already pass, so they are controls.

- [ ] **Step 3: Implement**

In `packages/shared/src/errors.ts`, replace `AccountBarredDetail` with:

```ts
export type AccountBarredDetail =
  | { readonly kind: "banned"; readonly reason?: string }
  | { readonly kind: "suspended"; readonly until: string; readonly reason?: string };
```

Update its doc comment: the reason is the moderator's statement of reasons from the newest suspend or ban action, never sent for a `terminate` (#114).

In `apps/api/src/auth/account-status.ts`, add `disabled_reason` to what callers must supply, and add a loader plus a third parameter:

```ts
export interface AccountStatusRow {
  readonly suspended_until: Date | null;
  readonly disabled_at: Date | null;
  /** 'ban' | 'terminate' | null. Optional so existing isBarred callers need no change. */
  readonly disabled_reason?: string | null;
}

/**
 * The statement of reasons for the bar now in force (#113): the newest
 * user_ban (if banned) or user_suspend (if suspended) row. ⚠️ NEVER for a
 * terminated account (#114). Called ONLY on the already-barred path, so a
 * normal login pays nothing.
 */
export async function loadBarReason(c: Client, userId: string, row: AccountStatusRow): Promise<string | null> {
  if (row.disabled_reason === "terminate") return null;
  const action = row.disabled_at !== null ? "user_ban" : "user_suspend";
  const { rows } = await c.query<{ reason: string }>(
    `SELECT reason FROM moderation_actions WHERE subject_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
    [userId, action],
  );
  return rows[0]?.reason ?? null;
}
```

Change `accountBarredResponse` to take `reason: string | null = null` as a third parameter and add `...(reason !== null && { reason })` to both branches of `barred`. Add `import type { Client } from "pg";`.

In `apps/api/src/routes/login.ts`, add `disabled_reason` to step 4's `SELECT`, and in the barred branch:

```ts
  if (isBarred(row)) {
    const reason = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => loadBarReason(c, row.id, row));
    return accountBarredResponse(row, {}, reason);
  }
```

Step 4's SELECT is `SELECT id, password_hash, suspended_until, disabled_at FROM users WHERE email = $1` (login.ts:245). Add `disabled_reason` to it and to its `UserRow` type. Keep the `isBarred(row)` statement literally as it is, because the AST guard in `test/login-bar-after-verify.node.test.ts` anchors on it.

In `apps/api/src/auth/pipeline.ts`, add `disabled_reason` to `readAccountGate`'s SELECT and to `AccountGateRow` (via `AccountStatusRow`), and in the barred branch:

```ts
    const reason = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => loadBarReason(c, session.userId, account));
    return accountBarredResponse(account, { "Set-Cookie": cookie }, reason);
```

In `apps/web/src/lib/barred-message.ts`, compute the base sentence as today, then:

```ts
  const reason = typeof barred?.reason === "string" && barred.reason.trim() !== "" ? barred.reason.trim() : null;
  return reason === null ? base : `${base} Reason given by the moderator: ${reason}`;
```

Restructure the function so all three existing return paths (`banned`, `suspended`, the undescribable fallback) go through `base`. The existing four tests must still pass unchanged.

- [ ] **Step 4: Run every barred suite**

Run: `cd apps/api && npx vitest run test/login-barred.test.ts test/pipeline-barred.test.ts test/login-bar-after-verify.node.test.ts test/account-status.node.test.ts` and `cd apps/web && npx vitest run test/barred-message.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation — the terminate exclusion**

Delete `if (row.disabled_reason === "terminate") return null;`, then run `login-barred.test.ts`. Expected: the TERMINATED test FAILS, because its fixture also has a `user_ban` row the loader would otherwise return. Restore the line.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/errors.ts apps/api/src/auth/account-status.ts apps/api/src/auth/pipeline.ts apps/api/src/routes/login.ts apps/web/src/lib/barred-message.ts apps/api/test/login-barred.test.ts apps/web/test/barred-message.test.ts
git commit -m "feat(auth): a barred user is told the moderator's reason — never for a CSAM termination (Part of #113)"
```

---

### Task 6: The admin account page, linked from the queue

**Files:**
- Modify: `apps/api/src/moderation/queue.ts`, `packages/shared/src/admin.ts` (`AdminQueueItem.authorHandle`), `apps/web/src/pages/admin/queue.astro`
- Create: `apps/web/src/pages/admin/accounts/[handle].astro`
- Test: `apps/api/test/moderation-queue.db.test.ts` (append), `apps/web/test/admin-account-page.test.ts`, `apps/web/test/admin-queue-page.test.ts` (append)

**Interfaces:**
- Consumes: the Task 4 routes, `AdminAccountResponse`, `ADMIN_ACCOUNT_ACTIONS`, `SUSPENSION_HOURS`, `DEFAULT_SUSPENSION_HOURS`, `REPORT_REASONS`.
- Produces: `QueueItem.authorHandle: string | null` (null for an anonymised author).

**Precondition:** #124 (#119's queue fix) has merged. Rebase on it before touching `queue.ts`.

- [ ] **Step 1: Failing queue test**

Append to `apps/api/test/moderation-queue.db.test.ts` (its `mkUser` inserts no profile, so give this test one):

```ts
  it("#113: each item carries its author's handle, for the account-page link", async () => {
    const author = await mkUser();
    const handle = `h${author.replace(/-/g, "").slice(0, 16)}`;
    await client.query(`INSERT INTO profiles (user_id, username) VALUES ($1, $2)`, [author, handle]);
    const r1 = await mkUser();
    const post = await mkPost(author, "Handled");
    await report(r1, post, "spam");
    const item = (await listOpenQueue(client)).find((i) => i.targetId === post)!;
    expect(item.authorHandle).toBe(handle);
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/api && npx vitest run test/moderation-queue.db.test.ts`
Expected: FAIL (`authorHandle` is undefined).

- [ ] **Step 3: Implement it in `queue.ts`**

In both arms of `SELECT_OPEN_QUEUE`, add a `LEFT JOIN profiles` on the content's `author_id` and select `pr.username AS author_handle`:
- post arm: `LEFT JOIN profiles apr ON apr.user_id = p.author_id`, selecting `apr.username AS author_handle`;
- comment arm: `LEFT JOIN profiles acr ON acr.user_id = c.author_id`, selecting `acr.username AS author_handle`.

Choose aliases that don't collide with the CTEs (`pr` is already the post CTE's alias). Add `author_handle: string | null` to `QueueRow`, `readonly authorHandle: string | null` to `QueueItem`, and map it. Add `authorHandle: string | null;` to `AdminQueueItem` in `packages/shared/src/admin.ts`. Do **not** change the aggregates or the ordering.

- [ ] **Step 4: Failing web source tests**

Create `apps/web/test/admin-account-page.test.ts`. Use the same source-pin technique as `admin-media-access-page.test.ts`: read it, copy `stripComments`, and keep the guard-ordering assertions:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const PAGE = join(import.meta.dirname, "..", "src", "pages", "admin", "accounts", "[handle].astro");
const source = stripComments(readFileSync(PAGE, "utf8"));

describe("/admin/accounts/[handle]", () => {
  it("⚠️ the Access-JWT guard is the FIRST executable statement", () => {
    const guardAt = source.indexOf("if (accessJwt === null");
    expect(guardAt).toBeGreaterThan(-1);
    for (const later of ["markPrivate(Astro)", "setPublicPageCsp(Astro)", "adminApiFetch("]) {
      expect(source.indexOf(later)).toBeGreaterThan(guardAt);
    }
  });

  it("posts to the account-action api and reads the account api", () => {
    expect(source).toContain("/actions`");
    expect(source).toMatch(/adminApiFetch<AdminAccountResponse>\(/);
  });

  it("offers ONLY warn/suspend/ban — never terminate", () => {
    expect(source).toContain("ADMIN_ACCOUNT_ACTIONS.map(");
    expect(source).not.toMatch(/terminate/i);
  });

  it("offers the adopted suspension durations, defaulting to 7 days", () => {
    expect(source).toContain("SUSPENSION_HOURS.map(");
    expect(source).toContain("DEFAULT_SUSPENSION_HOURS");
  });
});
```

Append to `apps/web/test/admin-queue-page.test.ts`:

```ts
describe("#113 — the queue LINKS to the account page and offers no account action (spec decision #3)", () => {
  it("links each item's author", () => {
    expect(source).toMatch(/href=\{`\/admin\/accounts\/\$\{encodeURIComponent\(item\.authorHandle\)\}`\}/);
  });
  it("has no account-action control on the decision form", () => {
    expect(source).not.toMatch(/\b(suspend|ban|warn)\b/i);
  });
});
```

(`admin-queue-page.test.ts` names its comment-stripped source `source`, at line 32.)

- [ ] **Step 5: Implement the page and the link**

Create `apps/web/src/pages/admin/accounts/[handle].astro`, modelled line for line on `apps/web/src/pages/admin/media-access.astro`: the same header comment structure, guard, `markPrivate`, `setPublicPageCsp`, `adminApiFetch`, `adminApiErrorCode`, error display and styles. Its frontmatter, after the guard:

```ts
const handle = Astro.params.handle ?? "";
let actionError: string | null = null;
let actionOk = false;

if (Astro.request.method === "POST") {
  const form = await Astro.request.formData();
  const action = form.get("action");
  const res = await adminApiFetch(`/admin/accounts/${encodeURIComponent(handle)}/actions`, {
    method: "POST",
    accessJwt,
    origin: Astro.request.headers.get("Origin") ?? "",
    body: {
      action,
      reason: form.get("reason"),
      ...(form.get("violationCategory") ? { violationCategory: form.get("violationCategory") } : {}),
      ...(action === "suspend" ? { suspensionHours: Number(form.get("suspensionHours")) } : {}),
    },
  });
  if (res.status === 200) actionOk = true;
  else actionError = adminApiErrorCode(res) ?? "ACTION_FAILED";
}

const accountResp = await adminApiFetch<AdminAccountResponse>(`/admin/accounts/${encodeURIComponent(handle)}`, { accessJwt });
const account = accountResp.status === 200 ? accountResp.data : null;
const loadError = accountResp.status !== 200 ? (adminApiErrorCode(accountResp) ?? "ACCOUNT_LOAD_FAILED") : null;
```

The body renders the handle and its current state (suspended until X, or banned since Y, or in good standing), the history list (each row's action, date, reason, and "counts toward escalation" or "older than 12 months"), and "Suggested next step: {account.suggestedNext} (advisory)". It then renders **one** form with:
- a required `reason` textarea (`maxlength="2000"`, labelled "Statement of reasons (shown to the user)");
- an optional `violationCategory` select over `REPORT_REASONS`;
- a `suspensionHours` select over `SUSPENSION_HOURS.map(...)`, with `selected` on `DEFAULT_SUSPENSION_HOURS` and labels 24h / 7 days / 30 days;
- one submit button per `ADMIN_ACCOUNT_ACTIONS.map(...)`, as `name="action" value={a}`.

The page offers nothing when `account.disabledAt` is set, beyond the line "This account is banned."

In `apps/web/src/pages/admin/queue.astro`, inside each item's `meta` line, add:

```astro
{item.authorHandle && (
  <a class="link" href={`/admin/accounts/${encodeURIComponent(item.authorHandle)}`}>@{item.authorHandle} — account</a>
)}
```

Put it in the meta line only, not in the decision form.

- [ ] **Step 6: Run the suites and typecheck**

Run: `cd apps/api && npx vitest run test/moderation-queue.db.test.ts test/admin-queue-route.test.ts`, `cd apps/web && npx vitest run test/admin-account-page.test.ts test/admin-queue-page.test.ts`, then `pnpm typecheck`.
Expected: PASS and clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/moderation/queue.ts packages/shared/src/admin.ts apps/web/src/pages/admin/accounts apps/web/src/pages/admin/queue.astro apps/api/test/moderation-queue.db.test.ts apps/web/test/admin-account-page.test.ts apps/web/test/admin-queue-page.test.ts
git commit -m "feat(admin): the account page, linked from the queue — warn/suspend/ban (Part of #113)"
```

---

### Task 7: Retire the "not yet true" notes this plan makes true

**Files:**
- Modify: `docs/legal/community-guidelines.md`, `docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md`

- [ ] **Step 1: The guidelines' actions-ladder note**

In `community-guidelines.md`'s "Actions ladder" bullet, replace the `[[NOT YET TRUE — status 2026-10-01: no suspension or termination mechanism exists yet (#113, #114). …]]` note with:

```markdown
[[STATUS — warning, suspension and ban exist (#113 plan A). "Immediate
termination" for CSAM exists as a primitive but is not yet wired to detection
or NCMEC reporting (#114). Appeals: #113 plan B.]]
```

Leave §1.2's CSAM note alone. It's still true and #114 owns it.

- [ ] **Step 2: The spec**

At the top of `docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md` §5, add one status line: `**Status (2026-10-01):** warn/suspend/ban BUILT (#113 plan A, docs/superpowers/plans/2026-10-01-m4-2c-enforcement-ladder.md); terminate primitive built, unwired (#114); appeals §6 = plan B; DSA §8 = plan C.`

- [ ] **Step 3: Commit**

```bash
git add docs/legal/community-guidelines.md docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md
git commit -m "docs: the ladder exists — retire its not-yet-true note (Part of #113)"
```

---

## Whole-branch checks (after Task 7)

- [ ] `pnpm typecheck` clean; `pnpm -r run test` green, except the four known local-only `media-backfill.test.ts` timeouts, which must be the same four by name.
- [ ] The PR body says **"Part of #113"**, with no close keyword, because appeals and DSA intake remain.
- [ ] The PR body lists every mutation run in Tasks 1, 4 and 5 with its result.
- [ ] Spec §12: AC-3 and AC-4 are already pinned (#35, #50). This plan adds no new AC, but the reaper's barred-account exclusion must still pass, since `reap-unverified.test.ts` is in the full run.
