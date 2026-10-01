import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadBarReason } from "../src/auth/account-status";
import { hashPassword } from "../src/auth/password";
import { withClient } from "../src/db/client";
import worker from "../src";

/**
 * Task 2 — barred accounts cannot log in.
 *
 * Covers `disabled_at` (permanent ban) and `suspended_until` (temporary
 * suspension that expires on its own). An expired suspension is NOT barred.
 *
 * Runs in the POOL project (real workerd).
 */

const ORIGIN = "https://community.thinkersjournal.com";
const VALID_PASSWORD = "correct-horse-battery-staple";

/** Emails created by a test, deleted in `afterEach`. */
const createdEmails: string[] = [];

/** A per-run-unique address, registered for cleanup. */
function uniqueEmail(): string {
  const email = `t2_${crypto.randomUUID()}@example.com`;
  createdEmails.push(email);
  return email;
}

/** Run a query through the FRESH (cache-disabled) binding. */
async function query(
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const result = await c.query(sql, params);
    return result.rows as Record<string, unknown>[];
  });
  await waitOnExecutionContext(ctx);
  return rows;
}

/** Insert a `users` row directly (login has no signup step to go through). */
async function insertUser(email: string, passwordHash: string): Promise<string> {
  const rows = await query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
    [email, passwordHash],
  );
  return String(rows[0]!.id);
}

/**
 * Update a user's account status directly.
 */
async function updateAccountStatus(
  email: string,
  disabled_at: Date | null,
  suspended_until: Date | null,
): Promise<void> {
  await query(
    "UPDATE users SET disabled_at = $1, suspended_until = $2 WHERE email = $3",
    [disabled_at, suspended_until, email],
  );
}

function loginRequest(
  body: unknown,
  headers: Record<string, string> = { Origin: ORIGIN },
): Request {
  return new Request("https://api.test/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** POST /auth/login through the Worker's router. */
async function login(
  email: string,
  password: string,
  headers?: Record<string, string>,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    loginRequest({ email, password }, headers),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(async () => {
  // Clear sessions so each case observes only its own writes.
  let cursor: string | undefined;
  do {
    const result = await env.SESSIONS.list(cursor ? { cursor } : undefined);
    await Promise.all(result.keys.map((k) => env.SESSIONS.delete(k.name)));
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor !== undefined);
});

afterEach(async () => {
  if (createdEmails.length > 0) {
    await query("DELETE FROM users WHERE email = ANY($1::citext[])", [
      createdEmails,
    ]);
    createdEmails.length = 0;
  }
});

describe("POST /auth/login — barred accounts", () => {
  it("⚠️ AC-4: a DISABLED account cannot log in with the correct password — and is told it is banned (#50 Q2)", async () => {
    const email = uniqueEmail();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    await insertUser(email, passwordHash);
    // Set disabled_at to now (permanent ban)
    await updateAccountStatus(email, new Date(), null);

    const res = await login(email, VALID_PASSWORD);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "ACCOUNT_BARRED", barred: { kind: "banned" } });
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("⚠️ AC-4: a currently-SUSPENDED account cannot log in — and is told until when (#50 Q2)", async () => {
    const email = uniqueEmail();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    await insertUser(email, passwordHash);
    // Set suspended_until to 1 day in the future
    const future = new Date();
    future.setTime(future.getTime() + 24 * 60 * 60 * 1000);
    await updateAccountStatus(email, null, future);

    const res = await login(email, VALID_PASSWORD);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      code: "ACCOUNT_BARRED",
      barred: { kind: "suspended", until: future.toISOString() },
    });
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("a ban wins over a suspension when both are set", async () => {
    const email = uniqueEmail();
    await insertUser(email, await hashPassword(VALID_PASSWORD));
    await updateAccountStatus(email, new Date(), new Date(Date.now() + 24 * 60 * 60 * 1000));

    const res = await login(email, VALID_PASSWORD);
    expect(await res.json()).toEqual({ code: "ACCOUNT_BARRED", barred: { kind: "banned" } });
  });

  it("an EXPIRED suspension does NOT bar login", async () => {
    const email = uniqueEmail();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    await insertUser(email, passwordHash);
    // Set suspended_until to 1 day in the past (expired)
    const past = new Date();
    past.setTime(past.getTime() - 24 * 60 * 60 * 1000);
    await updateAccountStatus(email, null, past);

    const res = await login(email, VALID_PASSWORD);
    expect(res.status).toBe(200);
  });

  // CONTROL: without this, "403" would be indistinguishable from "this
  // harness never logs anyone in".
  it("CONTROL: an ordinary account with the same password logs in fine", async () => {
    const otherEmail = uniqueEmail();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    await insertUser(otherEmail, passwordHash);

    const res = await login(otherEmail, VALID_PASSWORD);
    expect(res.status).toBe(200);
  });

  // ⚠️ STILL NO ACCOUNT-STATE ORACLE FOR A STRANGER. ACCOUNT_BARRED is only
  // ever said to someone who just proved the password. With a WRONG password a
  // barred account must stay indistinguishable from any other failed login —
  // the bar check sits after the verify (test/login-bar-after-verify.node.test.ts).
  it("⚠️ a barred account with a WRONG password gets the SAME generic 401 as any wrong password", async () => {
    const barredEmail = uniqueEmail();
    const otherEmail = uniqueEmail();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    await insertUser(barredEmail, passwordHash);
    await insertUser(otherEmail, passwordHash);
    await updateAccountStatus(barredEmail, new Date(), null);

    const barred = await login(barredEmail, "definitely-not-the-password");
    const wrong = await login(otherEmail, "definitely-not-the-password");

    expect(barred.status).toBe(401);
    expect(barred.status).toBe(wrong.status);
    expect(await barred.json()).toEqual(await wrong.json());
  });
});

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

  // ⚠️ loadBarReason's terminate exclusion is enforced TWICE (in-memory AND
  // in the query) — see src/auth/account-status.ts's comment. This drives the
  // SECOND enforcement directly: a `row` that OMITS `disabled_reason`
  // entirely (the field is optional on AccountStatusRow) cannot trip the
  // in-memory `row.disabled_reason === "terminate"` guard, so only the
  // query's own `NOT EXISTS` can still suppress the reason.
  describe("#113 fix: loadBarReason's terminate exclusion also lives in the query", () => {
    it("a row object omitting disabled_reason for a terminated user still yields no reason", async () => {
      const email = uniqueEmail();
      const userId = await insertUser(email, await hashPassword(VALID_PASSWORD));
      await query(`UPDATE users SET disabled_at = now(), disabled_reason = 'terminate' WHERE id = $1`, [userId]);
      await logAction(email, "user_ban", "must not be shown — in-memory guard is bypassed on purpose here");

      const ctx = createExecutionContext();
      const reason = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
        // Deliberately NOT passing disabled_reason — this is the row shape a
        // caller with a narrower SELECT (or a stale re-read) could produce.
        loadBarReason(c, userId, { suspended_until: null, disabled_at: new Date() }),
      );
      await waitOnExecutionContext(ctx);

      expect(reason).toBeNull();
    });

    // CONTROL: the same row shape for a plain ban DOES surface its reason —
    // without this, "null" above would be indistinguishable from "the query
    // never returns anything at all".
    it("CONTROL: the same row shape for an ordinary ban DOES surface its reason", async () => {
      const email = uniqueEmail();
      const userId = await insertUser(email, await hashPassword(VALID_PASSWORD));
      await query(`UPDATE users SET disabled_at = now(), disabled_reason = 'ban' WHERE id = $1`, [userId]);
      await logAction(email, "user_ban", "spam, repeatedly");

      const ctx = createExecutionContext();
      const reason = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
        loadBarReason(c, userId, { suspended_until: null, disabled_at: new Date() }),
      );
      await waitOnExecutionContext(ctx);

      expect(reason).toBe("spam, repeatedly");
    });
  });
});

/**
 * Review Focus 3 — the ban/login race. apps/api/src/routes/admin-accounts.ts's
 * double epoch-bump closes the race for every MUTATING-pipeline route (the
 * epoch is already stale by the time any later request reads it), but login
 * itself reads its epoch ONCE, synchronously, as part of minting a brand new
 * session — there is no "later request" for the bump to catch. If a ban
 * commits between login's row read (step 4) and its epoch read (step 8), the
 * stamped epoch is fine (it is read AFTER the bump that would matter), but
 * without a fresh re-read of the barring columns the stale `row` from step 4
 * would still sail a live session out the door. src/routes/login.ts's step 8b
 * closes exactly this gap.
 */
describe("#113 fix: a ban that lands between the row read and the epoch read still blocks the login", () => {
  it("banning the account inside getEpoch() -> 403 ACCOUNT_BARRED, no session minted", async () => {
    const email = uniqueEmail();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    const userId = await insertUser(email, passwordHash);

    // Wrap USER_SECURITY so THIS user's getEpoch() call — step 8, which runs
    // strictly after step 4's row read — first commits the ban, then
    // delegates to the real DO. Any other user's getByName is untouched.
    const realNamespace = env.USER_SECURITY;
    const racedEnv = {
      ...env,
      USER_SECURITY: {
        ...realNamespace,
        getByName(name: string) {
          const stub = realNamespace.getByName(name);
          if (name !== userId) return stub;
          // ⚠️ NOT a Proxy over the RPC stub — a Durable Object stub is a
          // Workers RPC receiver, and rebinding one of its methods through
          // Reflect/`.call` breaks the RPC machinery ("does not implement
          // the method 'call'"). A plain object with its own getEpoch that
          // delegates to the real stub avoids that entirely.
          return {
            getEpoch: async () => {
              await query(
                `UPDATE users SET disabled_at = now(), disabled_reason = 'ban' WHERE id = $1`,
                [userId],
              );
              return stub.getEpoch();
            },
            bumpEpoch: () => stub.bumpEpoch(),
          };
        },
      },
    } as unknown as Env;

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      loginRequest({ email, password: VALID_PASSWORD }),
      racedEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("ACCOUNT_BARRED");
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  // CONTROL: the same wrapped env, for an account nobody bans mid-flight,
  // still logs in fine — without this, the 403 above would be indistinguishable
  // from "the env-wrapping itself broke login".
  it("CONTROL: the same wrapped env, with no ban triggered, logs in fine", async () => {
    const email = uniqueEmail();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    await insertUser(email, passwordHash);
    const otherId = "00000000-0000-7000-8000-000000000000";

    const realNamespace = env.USER_SECURITY;
    const racedEnv = {
      ...env,
      USER_SECURITY: {
        ...realNamespace,
        getByName(name: string) {
          const stub = realNamespace.getByName(name);
          if (name !== otherId) return stub;
          return {
            getEpoch: async () => {
              await query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [otherId]);
              return stub.getEpoch();
            },
            bumpEpoch: () => stub.bumpEpoch(),
          };
        },
      },
    } as unknown as Env;

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      loginRequest({ email, password: VALID_PASSWORD }),
      racedEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
  });
});
