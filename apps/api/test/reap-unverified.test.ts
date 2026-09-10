import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { reapUnverifiedAccounts } from "../src/auth/reap-unverified";
import { withClient } from "../src/db/client";

/**
 * Task 8 (handle-at-signup) — the daily reaper.
 *
 * Handles are now claimed at signup, BEFORE email verification (see
 * src/routes/signup.ts), so an unverified/bot account squats both its handle
 * and its email for as long as it exists. `reapUnverifiedAccounts`
 * (src/auth/reap-unverified.ts) hard-deletes any account that never verified
 * within a 7-day grace window; `profiles`/`media`/`posts` all cascade off
 * `users` (see apps/api/migrations/), so deleting the `users` row is the
 * whole cleanup — including freeing the squatted `profiles.username` back up.
 *
 * Runs in the POOL project (real workerd) against the real Hyperdrive/Postgres
 * binding, same shape as test/email-drain.test.ts.
 */

const ALLOWED_ORIGIN = "http://localhost:8787";

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

/** Every user id this suite creates, for `afterEach` cleanup. */
const createdUserIds: string[] = [];

/**
 * Seed a user AND a claimed `profiles.username` (matching handle-at-signup —
 * the handle is claimed at the same time as the account), backdated to
 * `ageDays` old via an explicit `created_at`.
 */
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

async function present(id: string): Promise<boolean> {
  return ctxRun(async (c) => (await c.query(`SELECT 1 FROM users WHERE id = $1`, [id])).rowCount === 1);
}

/** True once nobody holds `username` — i.e. it is claimable again. */
async function usernameClaimable(username: string): Promise<boolean> {
  return ctxRun(
    async (c) => (await c.query(`SELECT 1 FROM profiles WHERE username = $1`, [username])).rowCount === 0,
  );
}

/** Residue cleanup — anything the reaper itself did not already delete. */
afterEach(async () => {
  if (createdUserIds.length === 0) return;
  await ctxRun((c) => c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]));
  createdUserIds.length = 0;
});

describe("reapUnverifiedAccounts", () => {
  it("deletes an unverified account older than 7 days, keeps recent-unverified and verified, and frees its handle", async () => {
    const oldUnverified = await seed({ verified: false, ageDays: 8 });
    const recentUnverified = await seed({ verified: false, ageDays: 1 });
    const oldVerified = await seed({ verified: true, ageDays: 30 });

    const ctx = createExecutionContext();
    await reapUnverifiedAccounts(env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await present(oldUnverified.id)).toBe(false); // reaped: unverified, past the 7-day grace window
    expect(await present(recentUnverified.id)).toBe(true); // too recent — keyed on created_at, not last-activity
    expect(await present(oldVerified.id)).toBe(true); // verified — never eligible regardless of age

    // The squat is gone: the handle is claimable again.
    expect(await usernameClaimable(oldUnverified.username)).toBe(true);
  });

  it("returns the number of accounts reaped", async () => {
    const oldUnverified = await seed({ verified: false, ageDays: 10 });

    const ctx = createExecutionContext();
    const n = await reapUnverifiedAccounts(env, ctx);
    await waitOnExecutionContext(ctx);

    // >=1, not ===1: the shared test DB may carry other suites' eligible rows
    // (see test/username-suggest.test.ts's header on why the DB is not
    // per-test-isolated). What this pins is that OUR fixture was counted.
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await present(oldUnverified.id)).toBe(false);
  });
});

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

describe("the scheduled dispatcher", () => {
  it('routes cron "30 3 * * *" to the reaper, not the email drain', async () => {
    const oldUnverified = await seed({ verified: false, ageDays: 8 });

    const ctx = createExecutionContext();
    await worker.scheduled(
      { cron: "30 3 * * *", scheduledTime: Date.now(), noRetry: () => {} },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Proof the reap ran (not the drain, which never touches `users`): the
    // account seeded ONLY for this cron branch is now gone.
    expect(await present(oldUnverified.id)).toBe(false);
  });
});

describe("POST /__test/reap-unverified", () => {
  it("invokes the reaper and reports { reaped }", async () => {
    const oldUnverified = await seed({ verified: false, ageDays: 8 });

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/__test/reap-unverified", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { reaped: number };
    expect(body.reaped).toBeGreaterThanOrEqual(1);
    expect(await present(oldUnverified.id)).toBe(false);
  });

  it("403s an origin-less request (same inline checkOrigin as signup/login)", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/__test/reap-unverified", { method: "POST" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
  });

  it("404s when TEST_ROUTES is unset — same as a nonexistent route", async () => {
    const prodEnv = { ...env, TEST_ROUTES: undefined } as unknown as Env;

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/__test/reap-unverified", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN },
      }),
      prodEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
  });
});
