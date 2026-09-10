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
| `apps/api/test/user-account-status-schema.db.test.ts` | **Create.** The 0015 column shape, and nothing else. |
| `apps/api/test/reap-unverified.test.ts` | **Modify.** The reaper guard (**AC-3**) — drives the real `reapUnverifiedAccounts`. |
| `apps/api/test/login-barred.test.ts` | **Create.** Login refusal (**AC-4**). |
| `apps/api/test/migrations.db.test.ts` | **Modify.** 0015 in the round-trip. |

---

## Task 1: Migration 0015 + the reaper guard

**Files:** create `migrations/0015_user_account_status.sql`; create `test/user-account-status-schema.db.test.ts`; modify `src/auth/reap-unverified.ts`, `test/reap-unverified.test.ts`, `test/migrations.db.test.ts`.

**Interfaces:** Produces `users.suspended_until`, `users.disabled_at`, `users.disabled_reason`.

⚠️ **AC-3 IS PINNED AGAINST THE REAL `reapUnverifiedAccounts`, NEVER A COPY OF ITS SQL.** An
earlier draft of this task gave the test its own `runReapPredicate()` helper holding a
hand-written duplicate of the reaper's `DELETE`. That test would have passed **whether or not
`src/auth/reap-unverified.ts` ever gained the guard** — it would have validated its own string.
The guard therefore lives in `test/reap-unverified.test.ts` (the **pool** project), which already
imports the production function and drives it against the real Hyperdrive binding. The
`.db.test.ts` below keeps only what it is actually the right instrument for: the shape of the
schema.

- [ ] **Step 1: Write the failing schema test**

Create `apps/api/test/user-account-status-schema.db.test.ts`:

```ts
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0015 — the SHAPE of the three account-status columns.
 *
 * Scope is deliberately narrow: this file asks `information_schema` what the
 * migration produced. It does NOT test the reaper. The reaper's AC-3 guard is
 * pinned in test/reap-unverified.test.ts, which drives the real
 * `reapUnverifiedAccounts` — a predicate re-typed into a test file proves
 * only that the test file's own string works.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});
afterAll(async () => { await client.end(); });

describe("users account status (0015)", () => {
  it("adds three nullable columns", async () => {
    const { rows } = await client.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='users'
          AND column_name IN ('suspended_until','disabled_at','disabled_reason')`,
    );
    expect(rows).toHaveLength(3);
    // Nullable is the point: NULL is "not barred", and it must be the state of
    // every account that already exists when this migration runs.
    for (const r of rows) expect(r.is_nullable, `${r.column_name}`).toBe("YES");
    const byName = new Map(rows.map((r) => [r.column_name, r.data_type]));
    expect(byName.get("suspended_until")).toBe("timestamp with time zone");
    expect(byName.get("disabled_at")).toBe("timestamp with time zone");
    expect(byName.get("disabled_reason")).toBe("text");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

`pnpm --filter @thinkersjournal/api exec vitest run --project node test/user-account-status-schema.db.test.ts`
Expected: FAIL — `expected [] to have a length of 3`.

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

- [ ] **Step 4: Add 0015 to the migration round-trip**

In `test/migrations.db.test.ts`, add `columnExists(client, "users", "disabled_at")` to all three
checkpoints — `true` / `false` / `true`.

- [ ] **Step 5: Apply the migration; the schema test goes green**

```bash
pnpm --filter @thinkersjournal/api run migrate:test
pnpm --filter @thinkersjournal/api exec vitest run --project node test/user-account-status-schema.db.test.ts test/migrations.db.test.ts
```
Expected: PASS.

- [ ] **Step 6: Write the AC-3 guard test — against the REAL reaper**

The columns now exist and the reaper is **still unguarded**, which is exactly the state in which
this test must first be run. In `apps/api/test/reap-unverified.test.ts`:

**6a.** Widen `seed()` to carry an optional account status. Replace its options type and its
`INSERT` (the rest of the helper is unchanged):

```ts
async function seed(opts: {
  verified: boolean;
  ageDays: number;
  disabledAt?: Date;
  suspendedUntil?: Date;
}): Promise<{ id: string; username: string }> {
  const unique = crypto.randomUUID().replace(/-/g, "");
  const username = `reap${unique.slice(0, 20)}`;
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at, created_at,
                          disabled_at, suspended_until)
       VALUES ($1, 'x', $2, now() - ($3 || ' days')::interval, $4, $5)
       RETURNING id`,
      [
        `reap-${unique}@example.com`,
        opts.verified ? new Date() : null,
        String(opts.ageDays),
        opts.disabledAt ?? null,
        opts.suspendedUntil ?? null,
      ],
    );
    const userId = rows[0]!.id;
    await c.query(`INSERT INTO profiles (user_id, username) VALUES ($1, $2)`, [userId, username]);
    return userId;
  });
  createdUserIds.push(id);
  return { id, username };
}
```

**6b.** Append this `describe` to the same file, after the existing `describe("reapUnverifiedAccounts", …)`:

```ts
/**
 * ⚠️ AC-3 (issue #35, design §12). A barred account that never verified its
 * email is unverified AND stale, so the reaper's ordinary predicate matches it
 * exactly. Deleting it takes the user AND THE EVIDENCE -- the record an appeal,
 * a DSA statement of reasons, or a preservation obligation is about.
 *
 * All three fixtures are reaped in ONE invocation, so the control is not a
 * separate run that could differ: if the reaper had simply stopped working,
 * the third assertion fails and the two guards prove nothing.
 */
describe("reapUnverifiedAccounts — a barred account is never reaped (AC-3)", () => {
  it("spares disabled and suspended accounts while still reaping an ordinary one", async () => {
    const disabled = await seed({ verified: false, ageDays: 30, disabledAt: new Date() });
    const suspended = await seed({
      verified: false,
      ageDays: 30,
      suspendedUntil: new Date(Date.now() + 864e5),
    });
    const ordinary = await seed({ verified: false, ageDays: 30 });

    const ctx = createExecutionContext();
    await reapUnverifiedAccounts(env, ctx);
    await waitOnExecutionContext(ctx);

    expect(
      await present(disabled.id),
      "a disabled account was deleted by the reaper — the ban and its evidence are gone",
    ).toBe(true);
    expect(
      await present(suspended.id),
      "a suspended account was deleted by the reaper — the ban and its evidence are gone",
    ).toBe(true);
    // CONTROL, in the same reap: without it, "survived" is indistinguishable
    // from "the reaper deleted nothing at all".
    expect(
      await present(ordinary.id),
      "the reaper deleted nothing — the two guards above prove nothing",
    ).toBe(false);
  });
});
```

- [ ] **Step 7: Run it — expect FAIL, and CHECK THE FAILURE IS THE RIGHT ONE**

```bash
pnpm --filter @thinkersjournal/api exec vitest run --project pool test/reap-unverified.test.ts
```
Expected: FAIL on the **first** assertion — *"a disabled account was deleted by the reaper"*.

⚠️ **If it fails on the third assertion instead** (`the reaper deleted nothing`), the reaper is
not running at all and this red says nothing about the guard — stop and find out why before
writing Step 8. ⚠️ **If it PASSES**, the fixtures are not reaching the reaper's predicate (wrong
`ageDays`, a stray `email_verified_at`) — a green here would make Step 8 unfalsifiable.

- [ ] **Step 8: Guard the reaper**

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
      // AC-3; test/reap-unverified.test.ts pins it against this function.
```

⚠️ **`suspended_until IS NULL`, not `suspended_until < now()`** — a *lapsed* suspension still
means this account has been moderated, and its history is worth more than a reclaimed handle.
This is deliberately **stricter than `isBarred` in Task 2**, where an expired suspension must let
the user log in again. The two predicates answer different questions; do not unify them.

- [ ] **Step 9: Run — expect PASS**

```bash
pnpm --filter @thinkersjournal/api exec vitest run --project pool test/reap-unverified.test.ts
pnpm --filter @thinkersjournal/api exec vitest run --project node
```
Expected: PASS — including the pre-existing reaper tests, which must be unaffected.

- [ ] **Step 10: Commit**

```bash
git add apps/api/migrations/0015_user_account_status.sql apps/api/src/auth/reap-unverified.ts \
        apps/api/test/user-account-status-schema.db.test.ts apps/api/test/reap-unverified.test.ts \
        apps/api/test/migrations.db.test.ts
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

**Spec coverage:** §3.2 (three columns, soft-disable, reaper guard) → Task 1. §5 login refusal → Task 2. **AC-3** → Task 1, pinned against the real `reapUnverifiedAccounts` in the pool project, with a control reaped in the SAME invocation proving the reaper still reaps. **AC-4** → Task 2 with a control proving the harness can log someone in.

**Placeholders:** none.

**Type consistency:** `AccountStatusRow` is produced in Task 2 Step 3 and consumed by `login.ts` in Step 4; its two fields match the migration's column names and the `SELECT` list exactly.

⚠️ **Validated before this plan was handed to anyone** — not before it was written, which is a distinction worth keeping honest, since the first draft of this sentence claimed the stronger thing:

| block | how |
|---|---|
| migration `0015` | executed against the live schema in a rolled-back transaction |
| the guarded reaper predicate | executed against the live schema — disabled survives `1`, suspended survives `1`, ordinary reaped `0` (the control). ⚠️ **This validated the SQL, not the shipped function.** It was run as a stand-alone statement, and the first draft then handed that same statement to the test as `runReapPredicate()` — which would have made AC-3 pass with `reap-unverified.ts` untouched. Task 1 Step 6 now drives the real `reapUnverifiedAccounts`, and Step 7 requires the red to arrive on the guard's own assertion. |
| `isBarred` | extracted from this file, `tsc --noEmit` **exit 0**, and all four states checked: clean `false`, disabled `true`, suspension-in-future `true`, **suspension-expired `false`** |

Four defects in previous modules came from plan code handed over as "use this verbatim" without being run, and the last hid in a *test fixture* rather than the implementation — which is why the fixtures and the reaper predicate were executed here too, not just the module under test.
