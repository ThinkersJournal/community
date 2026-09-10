# Issue #35 — Account Status: make a ban actually bar re-entry

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A suspended or banned account cannot log back in, and the unverified-account reaper cannot delete one.

**Architecture:** Three nullable-timestamp columns on `users` — the house idiom — consulted by the login query. The `security_epoch` already kills *existing* sessions; this closes the other half, which nothing today can express.

**Tech Stack:** Neon Postgres 18, node-pg-migrate, `pg` over Hyperdrive, vitest (`pool` = workerd, `node` = plain Node).

**Spec:** `docs/superpowers/specs/2026-09-06-m4-moderation-queue-design.md` §3.2 and §5. Issue **#35**.

## Global Constraints

- **Soft-disable only. Never a row delete.** The row and its content are evidence for appeals, DSA statements of reasons, and the CSAM preservation path.
- **This is the PRIMITIVE, not the ladder.** No warn/suspend/ban routes, no admin UI, no proportionality, no appeals — those are 2c. This ships the columns, the login refusal, and the reaper guard.
- ⚠️ **A status change MUST also bump the security epoch.** The column bars *re-entry*; the epoch kills *live sessions*. Neither alone is a ban. Nothing in this slice sets a status, so this binds **2c** — recorded in §"Carried forward" below as a binding condition on whatever first writes these columns.
- Login must not become an account-state oracle: a barred account returns the **same generic 401** as a wrong password (`unauthorized()`), never a distinguishable code. Login already refuses to enumerate users; barring must not undo that.

## ⚠️ Why this is worth its own slice

`docs/superpowers/specs/2026-07-13-community-platform-design.md` — the document that calls itself *"the authoritative decisions"* — claimed the platform had **"strongly-consistent ban"**. It did not. PR #41 struck the claim and left `apps/api/test/no-unbacked-ban-claim.node.test.ts` behind as a detector.

That detector is **green today because the claim was corrected, not because the capability exists.** Its condition is a conjunction:

```
enforceable = (a status column exists in migrations)
           && (login.ts consults one of them)
```

**This slice makes `enforceable` true**, which is the honest green. Leaving it means the only green we have is the documentation one — and a detector satisfiable *only* by editing prose becomes quiet pressure to reword rather than fix.

**Consumers blocked on this:** 2c's enforcement ladder, and the **CSAM termination hook**, which shares the primitive.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/0015_user_account_status.sql` | **Create.** `suspended_until`, `disabled_at`, `disabled_reason`. |
| `apps/api/src/auth/account-status.ts` | **Create.** One predicate: is this row barred right now? |
| `apps/api/src/routes/login.ts` | **Modify.** Select the columns; refuse a barred account. |
| `apps/api/src/auth/reap-unverified.ts` | **Modify.** Exclude barred rows from the delete. |
| `apps/api/test/user-account-status-schema.db.test.ts` | **Create.** Schema + the reaper guard (**AC-3**). |
| `apps/api/test/login-barred.test.ts` | **Create.** Login refusal (**AC-4**). |
| `apps/api/test/migrations.db.test.ts` | **Modify.** 0015 in the round-trip. |

---

## Task 1: Migration 0015 + the reaper guard

**Files:** create `0015_user_account_status.sql`; create `test/user-account-status-schema.db.test.ts`; modify `src/auth/reap-unverified.ts`, `test/migrations.db.test.ts`.

**Interfaces:** Produces `users.suspended_until`, `users.disabled_at`, `users.disabled_reason`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/user-account-status-schema.db.test.ts`:

```ts
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
const made: string[] = [];

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});
afterAll(async () => { await client.end(); });
afterEach(async () => {
  if (made.length > 0) {
    await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [made]);
    made.length = 0;
  }
});

/** An UNVERIFIED account older than the reaper's 7-day window. */
async function mkStaleUnverified(status: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO users (id, email, password_hash, email_verified_at, created_at,
                        suspended_until, disabled_at, disabled_reason)
     VALUES ($1, $2, 'h', NULL, now() - interval '30 days', $3, $4, $5)`,
    [id, `${id}@status.test`,
     status["suspended_until"] ?? null, status["disabled_at"] ?? null, status["disabled_reason"] ?? null],
  );
  made.push(id);
  return id;
}

const exists = async (id: string): Promise<boolean> => {
  const { rows } = await client.query(`SELECT 1 FROM users WHERE id = $1`, [id]);
  return rows.length === 1;
};

/** The reaper's predicate, as the implementation must have it after this task. */
async function runReapPredicate(): Promise<void> {
  await client.query(
    `DELETE FROM users
      WHERE id IN (
        SELECT id FROM users
         WHERE email_verified_at IS NULL
           AND created_at < now() - interval '7 days'
           AND disabled_at IS NULL
           AND suspended_until IS NULL
         ORDER BY created_at
         LIMIT 500
      )`,
  );
}

describe("users account status (0015)", () => {
  it("adds three nullable columns", async () => {
    const { rows } = await client.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='users'
          AND column_name IN ('suspended_until','disabled_at','disabled_reason')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.is_nullable, `${r.column_name}`).toBe("YES");
    const byName = new Map(rows.map((r) => [r.column_name, r.data_type]));
    expect(byName.get("suspended_until")).toBe("timestamp with time zone");
    expect(byName.get("disabled_at")).toBe("timestamp with time zone");
    expect(byName.get("disabled_reason")).toBe("text");
  });

  // ⚠️ AC-3 (binding, design §12). Without this, a banned account that never
  // verified its email is DELETED after 7 days -- the user AND the evidence.
  it("⚠️ AC-3: a DISABLED unverified account SURVIVES the reaper", async () => {
    const id = await mkStaleUnverified({ disabled_at: new Date(), disabled_reason: "csam" });
    await runReapPredicate();
    expect(await exists(id), "a disabled account was deleted by the reaper — the ban and its evidence are gone").toBe(true);
  });

  it("⚠️ AC-3: a SUSPENDED unverified account SURVIVES the reaper", async () => {
    const id = await mkStaleUnverified({ suspended_until: new Date(Date.now() + 864e5) });
    await runReapPredicate();
    expect(await exists(id)).toBe(true);
  });

  it("CONTROL: an ordinary stale unverified account is STILL reaped", async () => {
    // Without this, "survives" would be indistinguishable from "the reaper
    // stopped working", and both AC-3 tests would pass against a no-op.
    const id = await mkStaleUnverified();
    await runReapPredicate();
    expect(await exists(id), "the reaper deleted nothing — the guard above proves nothing").toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

`pnpm --filter @thinkersjournal/api exec vitest run --project node test/user-account-status-schema.db.test.ts`
Expected: FAIL — `column "suspended_until" of relation "users" does not exist`.

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/0015_user_account_status.sql`:

```sql
-- Up Migration
-- ACCOUNT STATUS (issue #35). Until now `users` had five columns and none of
-- them could express "this account is barred".
--
-- ⚠️ THE security_epoch KILLS EXISTING SESSIONS AND DOES NOTHING ABOUT NEW
-- ONES. A banned user re-authenticated, received a fresh session carrying the
-- CURRENT epoch, and the comparison passed. The ban survived exactly until the
-- next login. These columns are the other half.
--
-- ⚠️ SOFT-DISABLE ONLY, NEVER A ROW DELETE. The row and its content are
-- evidence -- for appeals, for DSA statements of reasons, and for the CSAM
-- preservation path that shares this primitive.
ALTER TABLE users ADD COLUMN suspended_until timestamptz;
ALTER TABLE users ADD COLUMN disabled_at     timestamptz;
ALTER TABLE users ADD COLUMN disabled_reason text;

-- The login lookup is by email and already indexed; these columns are read
-- from the row it finds, so they need no index of their own. The reaper's
-- predicate gains two IS NULL terms on a batch job that runs daily.

-- Down Migration
ALTER TABLE users DROP COLUMN IF EXISTS disabled_reason;
ALTER TABLE users DROP COLUMN IF EXISTS disabled_at;
ALTER TABLE users DROP COLUMN IF EXISTS suspended_until;
```

- [ ] **Step 4: Guard the reaper**

In `apps/api/src/auth/reap-unverified.ts`, add two terms to the inner `SELECT`:

```sql
           AND disabled_at IS NULL
           AND suspended_until IS NULL
```

and above the query, this comment:

```ts
      // ⚠️ A BARRED ACCOUNT IS NEVER REAPED, even unverified and stale. A ban
      // whose subject was never verified would otherwise be deleted after 7
      // days -- taking the user AND THE EVIDENCE with it. See issue #35 and
      // AC-3; test/user-account-status-schema.db.test.ts pins it.
```

- [ ] **Step 5: Add 0015 to the migration round-trip**

In `test/migrations.db.test.ts`, add `columnExists(client, "users", "disabled_at")` to all three checkpoints — `true` / `false` / `true`.

- [ ] **Step 6: Apply and verify**

`pnpm --filter @thinkersjournal/api run migrate:test && pnpm --filter @thinkersjournal/api exec vitest run --project node`
Expected: PASS, including the control proving the reaper still reaps.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/0015_user_account_status.sql apps/api/src/auth/reap-unverified.ts \
        apps/api/test/user-account-status-schema.db.test.ts apps/api/test/migrations.db.test.ts
git commit -m "feat(m4): account-status columns; the reaper never deletes a barred account"
```

---

## Task 2: Login refuses a barred account

**Files:** create `src/auth/account-status.ts`; modify `src/routes/login.ts`; create `test/login-barred.test.ts`.

**Interfaces:**
```ts
export interface AccountStatusRow {
  readonly suspended_until: Date | null;
  readonly disabled_at: Date | null;
}
export function isBarred(row: AccountStatusRow, now?: Date): boolean;
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/login-barred.test.ts`, mirroring the existing `test/login.test.ts` harness (read it first — reuse its request builder, origin header and body shape verbatim). Seed users directly with `pg`, then:

```ts
  it("⚠️ AC-4: a DISABLED account cannot log in with the correct password", async () => {
    const res = await login(email, password);
    expect(res.status).toBe(401);
  });

  it("⚠️ AC-4: a currently-SUSPENDED account cannot log in", async () => {
    const res = await login(email, password);   // suspended_until = now + 1 day
    expect(res.status).toBe(401);
  });

  it("an EXPIRED suspension does NOT bar login", async () => {
    const res = await login(email, password);   // suspended_until = now - 1 day
    expect(res.status).toBe(200);
  });

  // CONTROL: without this, "401" would be indistinguishable from "the password
  // was wrong" or "this harness never logs anyone in".
  it("CONTROL: an ordinary account with the same password logs in fine", async () => {
    const res = await login(otherEmail, password);
    expect(res.status).toBe(200);
  });

  // ⚠️ NO ACCOUNT-STATE ORACLE: a barred account must be indistinguishable
  // from a wrong password. Login already refuses to enumerate users; barring
  // must not undo that.
  it("⚠️ a barred account returns the SAME body as a wrong password", async () => {
    const barred = await login(email, password);
    const wrong = await login(otherEmail, "definitely-not-the-password");
    expect(barred.status).toBe(wrong.status);
    expect(await barred.json()).toEqual(await wrong.json());
  });
```

- [ ] **Step 2: Run it — expect FAIL** (barred accounts currently log in with 200).

- [ ] **Step 3: Implement the predicate**

Create `apps/api/src/auth/account-status.ts`:

```ts
/**
 * IS THIS ACCOUNT BARRED FROM AUTHENTICATING RIGHT NOW?
 *
 * ⚠️ The `security_epoch` invalidates EXISTING sessions and does nothing about
 * new ones. This is the other half: it decides whether a NEW session may be
 * issued at all. Neither alone is a ban (issue #35).
 *
 * `disabled_at` is permanent (ban, or CSAM termination). `suspended_until` is
 * temporary and EXPIRES ON ITS OWN — a suspension whose time has passed bars
 * nothing, which is what makes it a suspension rather than a ban.
 */
export interface AccountStatusRow {
  readonly suspended_until: Date | null;
  readonly disabled_at: Date | null;
}

export function isBarred(row: AccountStatusRow, now: Date = new Date()): boolean {
  if (row.disabled_at !== null) return true;
  if (row.suspended_until !== null && row.suspended_until.getTime() > now.getTime()) return true;
  return false;
}
```

- [ ] **Step 4: Wire it into login**

In `apps/api/src/routes/login.ts`, extend the lookup at step 4:

```ts
      "SELECT id, password_hash, suspended_until, disabled_at FROM users WHERE email = $1",
```

extend `UserRow` with `suspended_until: Date | null; disabled_at: Date | null;`, and add the refusal **immediately after the password verify succeeds** (step 5), before the rehash:

```ts
  // ⚠️ AFTER the password check, not before. Refusing earlier would make a
  // barred account answer faster than a wrong password and turn this route
  // into an account-state oracle — the same enumeration leak the DUMMY_HASH
  // verify above exists to prevent.
  if (isBarred(row)) {
    return unauthorized();
  }
```

- [ ] **Step 5: Run — expect PASS**, then the FULL suite and typecheck:

```
pnpm --filter @thinkersjournal/api exec vitest run \
  && pnpm --filter @thinkersjournal/api run typecheck
```

⚠️ Both. A previous module passed every test and still left the branch red on typecheck.

- [ ] **Step 6: Verify the detector flips green the honest way**

```
pnpm --filter @thinkersjournal/api exec vitest run --project node test/no-unbacked-ban-claim.node.test.ts
```
It was already green (the claim was struck). Confirm it is **now green for the other reason** by checking its own output fields: `status-bearing columns` non-empty and `login consults one of them: true`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/account-status.ts apps/api/src/routes/login.ts apps/api/test/login-barred.test.ts
git commit -m "feat(m4): login refuses a barred account (issue #35, AC-4)"
```

---

## Carried forward — binding on 2c

⚠️ **Whatever first WRITES these columns must also bump the security epoch, in the same operation.** The column bars re-entry; the epoch kills live sessions. A suspension that sets the column and forgets the epoch leaves the user acting until their cookie expires; one that bumps the epoch without the column bars nothing after their next login. **Neither half alone is a ban, and they are easy to separate by accident.**

This slice ships **no writer**, so there is nothing here to enforce it against — recording it as a condition on 2c rather than building a helper with no caller.

## Self-Review

**Spec coverage:** §3.2 (three columns, soft-disable, reaper guard) → Task 1. §5 login refusal → Task 2. **AC-3** → Task 1 with a control proving the reaper still reaps. **AC-4** → Task 2 with a control proving the harness can log someone in.

**Placeholders:** none.

**Type consistency:** `AccountStatusRow` is produced in Task 2 Step 3 and consumed by `login.ts` in Step 4; its two fields match the migration's column names and the `SELECT` list exactly.

⚠️ **Validated before this plan was handed to anyone** — not before it was written, which is a distinction worth keeping honest, since the first draft of this sentence claimed the stronger thing:

| block | how |
|---|---|
| migration `0015` | executed against the live schema in a rolled-back transaction |
| the guarded reaper predicate | executed; **AC-3 proven** — disabled survives `1`, suspended survives `1`, ordinary reaped `0` (the control) |
| `isBarred` | extracted from this file, `tsc --noEmit` **exit 0**, and all four states checked: clean `false`, disabled `true`, suspension-in-future `true`, **suspension-expired `false`** |

Four defects in previous modules came from plan code handed over as "use this verbatim" without being run, and the last hid in a *test fixture* rather than the implementation — which is why the fixtures and the reaper predicate were executed here too, not just the module under test.
