import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { anonymiseExpiredAccounts } from "../src/auth/anonymise-accounts";
import { createSession } from "../src/auth/session";
import { withClient } from "../src/db/client";

/**
 * Board item 59 = Option C — the daily anonymisation reaper.
 *
 * Same shape as test/reap-unverified.test.ts: real workerd, real Hyperdrive/
 * Postgres binding, fixtures backdated via an explicit `deletion_requested_at`.
 */

const ALLOWED_ORIGIN = "http://localhost:8787";
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZGlnZXN0";

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

const createdUserIds: string[] = [];

async function seed(opts: {
  requestedDaysAgo: number | null;
  disabledAt?: Date;
  suspendedUntil?: Date;
}): Promise<{ id: string; username: string }> {
  const unique = crypto.randomUUID().replace(/-/g, "");
  const username = `anon${unique.slice(0, 20)}`;
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at, deletion_requested_at,
                          disabled_at, suspended_until)
       VALUES ($1, $2, now(),
               CASE WHEN $3::int IS NULL THEN NULL ELSE now() - ($3 || ' days')::interval END,
               $4, $5)
       RETURNING id`,
      [
        `anon-${unique}@example.com`,
        PASSWORD_HASH,
        opts.requestedDaysAgo === null ? null : String(opts.requestedDaysAgo),
        opts.disabledAt ?? null,
        opts.suspendedUntil ?? null,
      ],
    );
    const userId = rows[0]!.id;
    await c.query(
      `INSERT INTO profiles (user_id, username, display_name, bio)
       VALUES ($1, $2, 'Real Name', 'A real bio')`,
      [userId, username],
    );
    return userId;
  });
  createdUserIds.push(id);
  return { id, username };
}

async function row(
  id: string,
): Promise<{
  email: string;
  passwordHash: string;
  anonymisedAt: Date | null;
  username: string;
  displayName: string | null;
  bio: string | null;
}> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{
      email: string;
      password_hash: string;
      anonymised_at: Date | null;
      username: string;
      display_name: string | null;
      bio: string | null;
    }>(
      `SELECT u.email, u.password_hash, u.anonymised_at, p.username, p.display_name, p.bio
         FROM users u JOIN profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [id],
    );
    const r = rows[0]!;
    return {
      email: r.email,
      passwordHash: r.password_hash,
      anonymisedAt: r.anonymised_at,
      username: r.username,
      displayName: r.display_name,
      bio: r.bio,
    };
  });
}

afterEach(async () => {
  if (createdUserIds.length === 0) return;
  await ctxRun((c) => c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]));
  createdUserIds.length = 0;
});

describe("anonymiseExpiredAccounts", () => {
  it("scrubs an account whose 30-day grace period has passed, keeps a recent request and a never-requested account untouched", async () => {
    const expired = await seed({ requestedDaysAgo: 31 });
    const recent = await seed({ requestedDaysAgo: 5 });
    const neverRequested = await seed({ requestedDaysAgo: null });

    const ctx = createExecutionContext();
    await anonymiseExpiredAccounts(env, ctx);
    await waitOnExecutionContext(ctx);

    const expiredRow = await row(expired.id);
    expect(expiredRow.anonymisedAt).not.toBeNull();
    expect(expiredRow.email).toBe(`deleted-${expired.id}@invalid.thinkersjournal.local`);
    // Chosen because it structurally fails password.ts's PHC_PATTERN — see
    // src/auth/anonymise-accounts.ts's own header.
    expect(expiredRow.passwordHash).toBe("!anonymised!");
    expect(expiredRow.username).toBe(`deleted-user-${expired.id}`);
    expect(expiredRow.displayName).toBeNull();
    expect(expiredRow.bio).toBeNull();

    const recentRow = await row(recent.id);
    expect(recentRow.anonymisedAt).toBeNull();
    expect(recentRow.username).toBe(recent.username);

    const neverRow = await row(neverRequested.id);
    expect(neverRow.anonymisedAt).toBeNull();
    expect(neverRow.username).toBe(neverRequested.username);
  });

  it("returns the number of accounts anonymised", async () => {
    const expired = await seed({ requestedDaysAgo: 45 });

    const ctx = createExecutionContext();
    const n = await anonymiseExpiredAccounts(env, ctx);
    await waitOnExecutionContext(ctx);

    // >=1, not ===1 — the shared test DB may carry other suites' eligible
    // rows (same reasoning as test/reap-unverified.test.ts). This pins that
    // OUR fixture was counted.
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await row(expired.id)).anonymisedAt).not.toBeNull();
  });

  it("scrubbing kills every live session for that account (security_epoch bump)", async () => {
    const expired = await seed({ requestedDaysAgo: 45 });

    const ctx = createExecutionContext();
    const epochBefore = await env.USER_SECURITY.getByName(expired.id).getEpoch();
    await anonymiseExpiredAccounts(env, ctx);
    await waitOnExecutionContext(ctx);
    const epochAfter = await env.USER_SECURITY.getByName(expired.id).getEpoch();

    expect(epochAfter).toBeGreaterThan(epochBefore);
  });
});

// ---- account legal hold (account-legal-hold spec §4, §4a) --------------------

/**
 * ⚠️ A UNIQUE FAR-PAST `deletion_requested_at` FOR EVERY FIXTURE BELOW (re-audit
 * S1). The reaper takes the oldest 500 eligible rows from the SHARED test DB,
 * and several files run it in parallel, so another file's run can scrub these
 * fixtures and this file's runs can scrub theirs. A far-past timestamp sorts a
 * fixture into the head of every run's batch, whatever else the DB holds. Which
 * run scrubbed a row is not deterministic; its end state is. So every
 * assertion below reads a fixture row's FINAL STATE, never the reaper's return
 * value or a log line.
 */
const FAR_PAST = "timestamptz '2000-01-01' + (random() * interval '1000 days')";

interface Fixture {
  id: string;
  username: string;
  /** The original address, deliberately mixed-case: the hash is of the NORMALISED one. */
  email: string;
}

/**
 * A verified account with a profile. `eligible` (default true) gives it a
 * unique far-past deletion request; false leaves `deletion_requested_at` NULL
 * (RF6/RF7 make it eligible later, under a lock). `banned` sets `disabled_at`
 * with `disabled_reason = 'ban'`.
 */
async function seedAccount(
  opts: { eligible?: boolean; banned?: boolean; suspendedUntil?: Date } = {},
): Promise<Fixture> {
  const unique = crypto.randomUUID().replace(/-/g, "");
  const username = `anon${unique.slice(0, 20)}`;
  const email = `Anon-${unique}@Example.com`;
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at, deletion_requested_at,
                          disabled_at, disabled_reason, suspended_until)
       VALUES ($1, $2, now(),
               CASE WHEN $3::boolean THEN ${FAR_PAST} ELSE NULL END,
               CASE WHEN $4::boolean THEN now() ELSE NULL END,
               CASE WHEN $4::boolean THEN 'ban' ELSE NULL END,
               $5)
       RETURNING id`,
      [email, PASSWORD_HASH, opts.eligible ?? true, opts.banned ?? false, opts.suspendedUntil ?? null],
    );
    const userId = rows[0]!.id;
    await c.query(
      `INSERT INTO profiles (user_id, username, display_name, bio)
       VALUES ($1, $2, 'Real Name', 'A real bio')`,
      [userId, username],
    );
    return userId;
  });
  createdUserIds.push(id);
  return { id, username, email };
}

async function seedEligible(): Promise<string> {
  return (await seedAccount()).id;
}

/** Autocommit, from its own client: a unique far-past deletion request. Changes no key column. */
async function makeEligible(id: string): Promise<void> {
  await ctxRun((c) => c.query(`UPDATE users SET deletion_requested_at = ${FAR_PAST} WHERE id = $1`, [id]));
}

/** An active hold, inserted directly (`account_legal_holds.user_id` is bare; rows can't be deleted). */
async function imposeHold(c: import("pg").Client, userId: string, category: "csam" | "dmca" | "other"): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO account_legal_holds (user_id, category, imposed_by, reason)
     VALUES ($1, $2, 'system', 'anonymise-accounts.test') RETURNING id`,
    [userId, category],
  );
  return rows[0]!.id;
}

async function anonymisedAt(id: string): Promise<Date | null> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ anonymised_at: Date | null }>("SELECT anonymised_at FROM users WHERE id = $1", [id]);
    return rows[0]!.anonymised_at;
  });
}

async function reservedHash(id: string): Promise<string | null> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ reserved_email_sha256: string | null }>(
      "SELECT reserved_email_sha256 FROM users WHERE id = $1",
      [id],
    );
    return rows[0]!.reserved_email_sha256;
  });
}

/** Computed here, independently of src/auth/reserved-email.ts: lowercase-hex sha256 of the lowercased address. */
async function expectedHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.toLowerCase()));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function runReaper(e: Env = env): Promise<number> {
  const ctx = createExecutionContext();
  const n = await anonymiseExpiredAccounts(e, ctx);
  await waitOnExecutionContext(ctx);
  return n;
}

/**
 * Polls (every 50 ms, at most 2 s — well under the scrub's 5 s lock_timeout)
 * until some backend is waiting on a lock held by `holderPid`. Postgres queues
 * a second waiter behind the FIRST waiter, and pg_blocking_pids reports only
 * the immediate blocker, so "blocked by the holder" allows one level of
 * transitivity (test/account-holds.test.ts's concurrency case found this).
 * Never matches on query text.
 */
async function waitUntilBlockedBy(holderPid: number): Promise<boolean> {
  return ctxRun(async (c) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { rowCount } = await c.query(
        `SELECT 1
           FROM pg_stat_activity w
          WHERE pg_blocking_pids(w.pid) @> ARRAY[$1::int]
             OR EXISTS (SELECT 1 FROM unnest(pg_blocking_pids(w.pid)) AS bp(pid)
                         WHERE pg_blocking_pids(bp.pid) @> ARRAY[$1::int])`,
        [holderPid],
      );
      if ((rowCount ?? 0) > 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  });
}

/**
 * RF6's choreography (plan Task 3, round 4). The fixture is committed but
 * INELIGIBLE, so no reaper (this file's or another's) can reach it early. A
 * second client takes `FOR KEY SHARE` on it; a third makes it eligible with an
 * autocommit `UPDATE` of a non-key column (`FOR NO KEY UPDATE`, which KEY SHARE
 * does not block). From that commit on, any reaper that selects the row blocks
 * on its own `FOR UPDATE`, which KEY SHARE does block. The reaper is started
 * (not awaited); the poll proves it is waiting on THIS lock; then the locking
 * client — which its own KEY SHARE never blocks — makes `change` and commits.
 */
async function whileReaperWaits(id: string, change: (locker: import("pg").Client) => Promise<unknown>): Promise<void> {
  const ctx = createExecutionContext();
  let reaper: Promise<number> | undefined;
  try {
    await ctxRun(async (locker) => {
      await locker.query("BEGIN");
      try {
        await locker.query("SELECT 1 FROM users WHERE id = $1 FOR KEY SHARE", [id]);
        const { rows } = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const lockerPid = rows[0]!.pid;
        await makeEligible(id);
        reaper = anonymiseExpiredAccounts(env, ctx);
        // Awaited below; this only stops an early rejection being reported as unhandled.
        reaper.catch(() => undefined);
        if (!(await waitUntilBlockedBy(lockerPid))) {
          throw new Error(`timed out after 2s waiting for a reaper to block on locker pid ${lockerPid}`);
        }
        await change(locker);
        await locker.query("COMMIT");
      } catch (err) {
        try {
          await locker.query("ROLLBACK");
        } catch {
          // keep the root error
        }
        throw err;
      }
    });
  } finally {
    if (reaper !== undefined) await Promise.allSettled([reaper]);
    await waitOnExecutionContext(ctx);
  }
  await reaper;
}

/**
 * ⚠️ REWRITTEN FOR THE NEW RULE (account-legal-hold spec §0/§4). This block
 * used to pin "a barred account is never scrubbed". CireSnave ruled that a
 * legal hold, not a ban, blocks deletion; the PM ruled that
 * `disabled_at`/`suspended_until` are pure access control. So a banned or
 * suspended account with NO hold IS anonymised (AH-2), and an account with an
 * active hold is NOT, whatever its ban state (AH-1).
 */
describe("anonymiseExpiredAccounts — a held account is never scrubbed; a ban alone does not gate deletion", () => {
  it("AH-2: banned, suspended and lapsed-suspended accounts with no hold ARE anonymised", async () => {
    const banned = await seedAccount({ banned: true });
    const suspended = await seedAccount({ suspendedUntil: new Date(Date.now() + 864e5) });
    const lapsed = await seedAccount({ suspendedUntil: new Date(Date.now() - 864e5) });

    await runReaper();

    expect((await row(banned.id)).anonymisedAt, "a banned, unheld account was spared").not.toBeNull();
    expect((await row(suspended.id)).anonymisedAt, "a suspended, unheld account was spared").not.toBeNull();
    expect((await row(lapsed.id)).anonymisedAt, "a lapsed-suspended, unheld account was spared").not.toBeNull();
  });

  it("AH-1 / RF2: a held account is not anonymised, whatever its ban state; after a dmca release the next run proceeds", async () => {
    // Held but neither banned nor suspended: proves the hold ALONE gates it.
    const heldPlain = await seedAccount();
    const heldBanned = await seedAccount({ banned: true });
    const heldSuspended = await seedAccount({ suspendedUntil: new Date(Date.now() + 864e5) });
    const control = await seedAccount();
    const dmcaHoldId = await ctxRun(async (c) => {
      const holdId = await imposeHold(c, heldPlain.id, "dmca");
      await imposeHold(c, heldBanned.id, "csam");
      await imposeHold(c, heldSuspended.id, "other");
      return holdId;
    });

    await runReaper();

    for (const [name, f] of [["held, unbarred", heldPlain], ["held, banned", heldBanned], ["held, suspended", heldSuspended]] as const) {
      const r = await row(f.id);
      expect(r.anonymisedAt, `${name} account was anonymised`).toBeNull();
      expect(r.email).toBe(f.email);
      expect(r.username).toBe(f.username);
      expect(r.displayName).toBe("Real Name");
    }
    // CONTROL, in the same run: "spared" is otherwise indistinguishable from "scrubbed nothing".
    expect((await row(control.id)).anonymisedAt, "the reaper scrubbed nothing").not.toBeNull();

    await ctxRun((c) =>
      c.query(
        `UPDATE account_legal_holds
            SET released_at = now(), released_by = 'mod2@example.com', release_reason = 'test release'
          WHERE id = $1`,
        [dmcaHoldId],
      ),
    );
    await runReaper();

    expect((await row(heldPlain.id)).anonymisedAt, "a released hold still blocked deletion").not.toBeNull();
    expect((await row(heldBanned.id)).anonymisedAt).toBeNull();
    expect((await row(heldSuspended.id)).anonymisedAt).toBeNull();
  });
});

describe("anonymiseExpiredAccounts — a banned account's address is reserved by hash (AH-7 / RF1)", () => {
  it("a banned, unheld account is scrubbed like any other and reserved_email_sha256 = sha256(lowercased original email)", async () => {
    const f = await seedAccount({ banned: true });

    await runReaper();

    const r = await row(f.id);
    expect(r.anonymisedAt).not.toBeNull();
    expect(r.email).toBe(`deleted-${f.id}@invalid.thinkersjournal.local`);
    expect(r.passwordHash).toBe("!anonymised!");
    expect(r.username).toBe(`deleted-user-${f.id}`);
    expect(r.displayName).toBeNull();
    expect(r.bio).toBeNull();
    expect(await reservedHash(f.id)).toBe(await expectedHash(f.email));
  });

  it("CONTROL: a non-banned account is scrubbed the same way with reserved_email_sha256 NULL", async () => {
    const f = await seedAccount();

    await runReaper();

    const r = await row(f.id);
    expect(r.anonymisedAt).not.toBeNull();
    expect(r.email).toBe(`deleted-${f.id}@invalid.thinkersjournal.local`);
    expect(r.passwordHash).toBe("!anonymised!");
    expect(r.username).toBe(`deleted-user-${f.id}`);
    expect(r.displayName).toBeNull();
    expect(r.bio).toBeNull();
    expect(await reservedHash(f.id)).toBeNull();
  });
});

describe("anonymiseExpiredAccounts — each scrub locks the row and re-checks it (RF6)", () => {
  it("a dmca hold inserted while the reaper waits: not anonymised, profile untouched", async () => {
    const f = await seedAccount({ eligible: false });

    await whileReaperWaits(f.id, (locker) => imposeHold(locker, f.id, "dmca"));

    const r = await row(f.id);
    expect(r.anonymisedAt, "a hold that landed while the reaper waited was not honoured").toBeNull();
    expect(r.email).toBe(f.email);
    expect(r.username).toBe(f.username);
    expect(r.displayName).toBe("Real Name");
    expect(r.bio).toBe("A real bio");
  });

  it("disabled_at cleared while the reaper waits (banned at SELECT time): anonymised with reserved_email_sha256 NULL", async () => {
    const f = await seedAccount({ eligible: false, banned: true });

    await whileReaperWaits(f.id, (locker) =>
      locker.query("UPDATE users SET disabled_at = NULL, disabled_reason = NULL WHERE id = $1", [f.id]),
    );

    expect(await anonymisedAt(f.id)).not.toBeNull();
    expect(await reservedHash(f.id)).toBeNull();
  });

  it("disabled_at set while the reaper waits (not banned at SELECT time): anonymised with the hash set", async () => {
    const f = await seedAccount({ eligible: false });

    await whileReaperWaits(f.id, (locker) =>
      locker.query("UPDATE users SET disabled_at = now(), disabled_reason = 'ban' WHERE id = $1", [f.id]),
    );

    expect(await anonymisedAt(f.id)).not.toBeNull();
    expect(await reservedHash(f.id)).toBe(await expectedHash(f.email));
  });

  it("deletion_requested_at set to NULL while the reaper waits: not anonymised", async () => {
    const f = await seedAccount({ eligible: false });

    await whileReaperWaits(f.id, (locker) =>
      locker.query("UPDATE users SET deletion_requested_at = NULL WHERE id = $1", [f.id]),
    );

    expect(await anonymisedAt(f.id)).toBeNull();
    expect((await row(f.id)).email).toBe(f.email);
  });
});

describe("anonymiseExpiredAccounts — one row's failure never stops the batch (RF7, re-audit B1a)", () => {
  it(
    "a row locked past the 5 s lock_timeout is skipped; the run resolves; every other row is scrubbed AND revoked",
    async () => {
      // X is seeded INELIGIBLE and locked before it becomes eligible, by the
      // same KEY SHARE choreography as RF6, so no other file's reaper can scrub
      // it before the lock is held. KEY SHARE blocks the reaper's FOR UPDATE
      // exactly as a FOR UPDATE would.
      const x = await seedAccount({ eligible: false });
      const y = await seedAccount();
      const ySessionEpoch = await env.USER_SECURITY.getByName(y.id).getEpoch();
      await createSession(env, {
        userId: y.id,
        roles: [],
        securityEpoch: ySessionEpoch,
        csrfSecret: "rf7-csrf-secret",
        createdAt: Date.now(),
      });
      // CONTROL for the bump: before the run, Y's epoch is the session's.
      expect(await env.USER_SECURITY.getByName(y.id).getEpoch()).toBe(ySessionEpoch);

      await ctxRun(async (locker) => {
        await locker.query("BEGIN");
        try {
          await locker.query("SELECT 1 FROM users WHERE id = $1 FOR KEY SHARE", [x.id]);
          const lockedAt = Date.now();
          await makeEligible(x.id);

          const ctx = createExecutionContext();
          const outcome = await anonymiseExpiredAccounts(env, ctx).then(
            (n) => ({ ok: true as const, n }),
            (err: unknown) => ({ ok: false as const, err }),
          );
          await waitOnExecutionContext(ctx);

          expect(outcome, "the reaper threw on one locked row").toMatchObject({ ok: true });
          expect(await anonymisedAt(x.id), "a row locked past lock_timeout was scrubbed").toBeNull();
          expect(await anonymisedAt(y.id), "the locked row stopped the batch").not.toBeNull();
          expect(
            await env.USER_SECURITY.getByName(y.id).getEpoch(),
            "Y was scrubbed but its sessions were not revoked",
          ).not.toBe(ySessionEpoch);

          // Hold X's lock for 7 s in all, past the 5 s lock_timeout.
          const rest = 7000 - (Date.now() - lockedAt);
          if (rest > 0) await new Promise((r) => setTimeout(r, rest));
          await locker.query("COMMIT");
        } catch (err) {
          try {
            await locker.query("ROLLBACK");
          } catch {
            // keep the root error
          }
          throw err;
        }
      });

      await runReaper();
      expect(await anonymisedAt(x.id), "the skipped row was not retried by the next run").not.toBeNull();
    },
    30_000,
  );
});

/**
 * An env whose USER_SECURITY wraps the real binding: it records, for each
 * bumpEpoch, whether that user's row was already anonymised at that moment,
 * and throws for every user `failFor` matches. Everything else passes through.
 */
function recordingEnv(failFor: (userId: string) => boolean, log: Array<{ userId: string; anonymised: boolean }>): Env {
  const real = env.USER_SECURITY;
  const stub = {
    getByName(userId: string) {
      const stubInstance = real.getByName(userId);
      return {
        getEpoch: () => stubInstance.getEpoch(),
        bumpEpoch: async () => {
          const rows = await ctxRun(async (c) =>
            (await c.query<{ anonymised: boolean }>(
              "SELECT anonymised_at IS NOT NULL AS anonymised FROM users WHERE id = $1",
              [userId],
            )).rows,
          );
          log.push({ userId, anonymised: rows[0]?.anonymised ?? false });
          if (failFor(userId)) throw new Error("forced pre-scrub bump failure");
          return stubInstance.bumpEpoch();
        },
      };
    },
  };
  return { ...env, USER_SECURITY: stub as unknown as Env["USER_SECURITY"] };
}

describe("anonymiseExpiredAccounts — revoke before the scrub and after it (RF8, round 3)", () => {
  it("RF8: each row is revoked BEFORE its scrub and again after it; a failed pre-scrub bump leaves the row unscrubbed", async () => {
    const x = await seedEligible(); // unique far-past deletion_requested_at (see the flake note)
    const y = await seedEligible();
    const log: Array<{ userId: string; anonymised: boolean }> = [];

    const ctx = createExecutionContext();
    await expect(anonymiseExpiredAccounts(recordingEnv((id) => id === x, log), ctx)).resolves.toBeTypeOf("number");
    await waitOnExecutionContext(ctx);

    // X: its first bump threw, so it was skipped — not scrubbed, retried next run.
    expect(await anonymisedAt(x)).toBeNull();
    expect(log.filter((e) => e.userId === x)).toEqual([{ userId: x, anonymised: false }]);
    // Y: bumped once before the scrub (row not yet anonymised), once after it.
    expect(await anonymisedAt(y)).not.toBeNull();
    expect(log.filter((e) => e.userId === y)).toEqual([
      { userId: y, anonymised: false },
      { userId: y, anonymised: true },
    ]);
  });

  it("RF8: when every candidate fails, the run throws after the loop", async () => {
    await seedEligible();
    await seedEligible();
    const ctx = createExecutionContext();
    // Every bump throws, so every candidate in this run fails, whatever else the
    // shared DB holds: F === N.
    await expect(anonymiseExpiredAccounts(recordingEnv(() => true, []), ctx)).rejects.toThrow(/all \d+ candidate\(s\) failed/);
    await waitOnExecutionContext(ctx);
    // The partial case (one failing of two does NOT throw) is the test above:
    // X failed, Y was scrubbed, and the run resolved.
  });
});

describe("the scheduled dispatcher", () => {
  it('routes cron "40 4 * * *" to the anonymisation reaper, not the email drain', async () => {
    const expired = await seed({ requestedDaysAgo: 45 });

    const ctx = createExecutionContext();
    await worker.scheduled(
      { cron: "40 4 * * *", scheduledTime: Date.now(), noRetry: () => {} },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect((await row(expired.id)).anonymisedAt).not.toBeNull();
  });
});

describe("POST /__test/anonymise-accounts", () => {
  it("invokes the reaper and reports { anonymised }", async () => {
    const expired = await seed({ requestedDaysAgo: 45 });

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/__test/anonymise-accounts", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { anonymised: number };
    expect(body.anonymised).toBeGreaterThanOrEqual(1);
    expect((await row(expired.id)).anonymisedAt).not.toBeNull();
  });

  it("403s an origin-less request (same inline checkOrigin as the other test seams)", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/__test/anonymise-accounts", { method: "POST" }),
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
      new Request("https://api.test/__test/anonymise-accounts", {
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
