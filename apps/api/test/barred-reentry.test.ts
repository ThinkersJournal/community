import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { anonymiseExpiredAccounts } from "../src/auth/anonymise-accounts";
import { verifyPassword } from "../src/auth/password";
import { createResetToken } from "../src/auth/password-reset";
import { releaseReservedEmail } from "../src/auth/reserved-email";
import { withClient } from "../src/db/client";
import { withAnonymiseReaperLock } from "./helpers/anonymise-reaper-lock";

/**
 * ISSUE #50, the two SESSION-ISSUING side doors found by its route census.
 *
 * #35 made `POST /auth/login` refuse a barred account. Two other routes also
 * mint a session and had no bar check, so either one let a barred user back in
 * without going through login:
 *
 *   • `POST /auth/reset-password` — forgot -> reset handed a barred account a
 *     fresh session. PM ruling (Q3): KEEP the password change (the token proved
 *     control of the address), skip `createSession`, and answer the same 200.
 *   • `POST /auth/signup` re-signup — the upsert's `WHERE email_verified_at IS
 *     NULL` let ANYONE who knows a barred UNVERIFIED address rewrite its
 *     password and handle, bump its epoch and receive a session. PM ruling
 *     (Q3b, option B): the upsert's WHERE also excludes a barred row, so the
 *     answer is the existing 409 EMAIL_TAKEN and the row is untouched.
 *
 * Runs in the POOL project (real workerd, real Postgres, real USER_SECURITY DO).
 */

const ALLOWED_ORIGIN = "http://localhost:8787";
const NEW_PASSWORD = "a-brand-new-password-123";
const DAY_MS = 24 * 60 * 60 * 1000;
// A valid PHC string for the NOT NULL column.
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZGlnZXN0";

type Status = "disabled" | "suspended" | "lapsed" | "ordinary";

const createdUserIds: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  if (createdUserIds.length === 0) return;
  await query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUserIds]);
  createdUserIds.length = 0;
});

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => (await c.query(sql, params)).rows as T[]);
  await waitOnExecutionContext(ctx);
  return rows;
}

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

interface Seeded {
  userId: string;
  email: string;
  username: string;
}

/** A user + profile in `status`; `verified` picks `email_verified_at`. */
async function seedUser(status: Status, verified: boolean): Promise<Seeded> {
  const unique = crypto.randomUUID().replace(/-/g, "");
  const email = `r50_${unique}@example.com`;
  const username = `r${unique.slice(0, 20)}`;
  const now = Date.now();
  const disabledAt = status === "disabled" ? new Date(now) : null;
  const suspendedUntil =
    status === "suspended" ? new Date(now + DAY_MS) : status === "lapsed" ? new Date(now - DAY_MS) : null;

  const [row] = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, email_verified_at, disabled_at, suspended_until)
     VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END, $4, $5) RETURNING id`,
    [email, PASSWORD_HASH, verified, disabledAt, suspendedUntil],
  );
  const userId = row!.id;
  createdUserIds.push(userId);
  await query("INSERT INTO profiles (user_id, username) VALUES ($1, $2)", [userId, username]);
  return { userId, email, username };
}

async function snapshot(userId: string): Promise<{ password_hash: string; username: string; epoch: number }> {
  const [row] = await query<{ password_hash: string; username: string }>(
    "SELECT u.password_hash, p.username FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1",
    [userId],
  );
  return { ...row!, epoch: await env.USER_SECURITY.getByName(userId).getEpoch() };
}

// ---- POST /auth/reset-password -------------------------------------------------

async function resetPassword(userId: string): Promise<Response> {
  const ctx = createExecutionContext();
  const token = await createResetToken(env, ctx, userId);
  await waitOnExecutionContext(ctx);
  return fetchWorker(
    new Request("https://api.test/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ token, password: NEW_PASSWORD }),
    }),
  );
}

describe("#50 — POST /auth/reset-password does not log a barred account in", () => {
  it.each(["disabled", "suspended"] as const)(
    "a %s account: 200 with NO session, and the password change still lands",
    async (status) => {
      const user = await seedUser(status, true);
      const res = await resetPassword(user.userId);

      expect(res.status).toBe(200);
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(await res.text()).toBe("");
      // Kept by ruling: the token proved control of the address.
      const [row] = await query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [
        user.userId,
      ]);
      expect(await verifyPassword(NEW_PASSWORD, row!.password_hash)).toBe(true);
    },
  );

  it.each(["lapsed", "ordinary"] as const)(
    "CONTROL a %s account: 200 WITH a session, the same empty body",
    async (status) => {
      const user = await seedUser(status, true);
      const res = await resetPassword(user.userId);

      expect(res.status).toBe(200);
      expect(res.headers.get("Set-Cookie")).toMatch(/^tj_session=/);
      expect(await res.text()).toBe("");
    },
  );
});

// ---- POST /auth/signup (re-signup of an UNVERIFIED row) -----------------------

/** Stub Turnstile (pass) and Postmark (accept); anything else fails loudly. */
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://challenges.cloudflare.com/")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.startsWith("https://api.postmarkapp.com/")) {
        return new Response(JSON.stringify({ ErrorCode: 0 }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
}

async function resignup(email: string): Promise<Response> {
  stubFetch();
  const handle = `n${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  return fetchWorker(
    new Request("https://api.test/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ email, password: NEW_PASSWORD, username: handle, turnstileToken: "dummy" }),
    }),
  );
}

describe("#50 — re-signup cannot touch a barred UNVERIFIED account", () => {
  it.each(["disabled", "suspended"] as const)(
    "a %s unverified row: 409 EMAIL_TAKEN, and password_hash, epoch and username are all unchanged",
    async (status) => {
      const user = await seedUser(status, false);
      const before = await snapshot(user.userId);

      const res = await resignup(user.email);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("EMAIL_TAKEN");
      expect(res.headers.get("Set-Cookie")).toBeNull();
      // Asserted directly, not inferred from the 409 (PM ruling Q3b).
      const after = await snapshot(user.userId);
      expect(after.password_hash).toBe(before.password_hash);
      expect(after.epoch).toBe(before.epoch);
      expect(after.username).toBe(before.username);
    },
  );

  it.each(["lapsed", "ordinary"] as const)(
    "CONTROL a %s unverified row: the re-signup still takes it over, as today",
    async (status) => {
      const user = await seedUser(status, false);
      const before = await snapshot(user.userId);

      const res = await resignup(user.email);

      expect(res.status).toBe(201);
      expect(res.headers.get("Set-Cookie")).toMatch(/^tj_session=/);
      const after = await snapshot(user.userId);
      expect(after.password_hash).not.toBe(before.password_hash);
      expect(after.epoch).not.toBe(before.epoch);
      expect(after.username).not.toBe(before.username);
    },
  );
});

// ---- POST /auth/signup — a deleted, banned account's address stays reserved -----

/**
 * AH-7 (account-legal-hold spec §4a, PM ruling B). A banned account deleted by
 * the anonymise reaper loses its real email like any other, so the upsert's
 * barred-row WHERE (unchanged, AH-6) no longer sees it. What refuses the
 * address now is the hash the reaper stored, checked after the upsert, with the
 * SAME 409 EMAIL_TAKEN as the barred case above.
 *
 * ⚠️ Each case first asserts the reaper really scrubbed the fixture. Otherwise
 * the row would still hold the address, the barred-row guard would answer the
 * 409, and the case would prove nothing about the hash.
 *
 * The reaper reads the SHARED test DB and other files run it in parallel, so
 * fixtures get a unique far-past `deletion_requested_at` (it sorts them into
 * every run's batch) and only their end state is asserted.
 */
async function seedDeleted(banned: boolean): Promise<Seeded> {
  const user = await seedUser(banned ? "disabled" : "ordinary", true);
  await query(
    `UPDATE users
        SET deletion_requested_at = timestamptz '2000-01-01' + (random() * interval '1000 days'),
            disabled_reason = CASE WHEN disabled_at IS NULL THEN NULL ELSE 'ban' END
      WHERE id = $1`,
    [user.userId],
  );
  // Serialised against every other file's run (helpers/anonymise-reaper-lock.ts).
  await withAnonymiseReaperLock(async () => {
    const ctx = createExecutionContext();
    await anonymiseExpiredAccounts(env, ctx);
    await waitOnExecutionContext(ctx);
  });

  const [row] = await query<{ email: string; anonymised_at: Date | null }>(
    "SELECT email, anonymised_at FROM users WHERE id = $1",
    [user.userId],
  );
  expect(row!.anonymised_at, "precondition: the reaper did not anonymise the fixture").not.toBeNull();
  expect(row!.email).toBe(`deleted-${user.userId}@invalid.thinkersjournal.local`);
  return user;
}

/** Track a row a successful re-signup created, for `afterEach`. */
async function trackSignup(email: string): Promise<void> {
  const rows = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
  expect(rows).toHaveLength(1);
  createdUserIds.push(rows[0]!.id);
}

async function expectEmailTaken(res: Response, email: string): Promise<void> {
  // A wrongly accepted signup created a row: track it so a failure leaves no residue.
  if (res.status === 201) {
    for (const r of await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email])) {
      createdUserIds.push(r.id);
    }
  }
  expect(res.status).toBe(409);
  expect(((await res.json()) as { code: string }).code).toBe("EMAIL_TAKEN");
  expect(res.headers.get("Set-Cookie")).toBeNull();
  expect(await query("SELECT id FROM users WHERE email = $1", [email])).toEqual([]);
}

describe("AH-7 — a deleted, banned account's address is reserved against re-signup", () => {
  it("re-signup with the address, in any letter case: the same 409 EMAIL_TAKEN, no session, no row", async () => {
    const user = await seedDeleted(true);

    await expectEmailTaken(await resignup(user.email), user.email);
    await expectEmailTaken(await resignup(user.email.toUpperCase()), user.email);
  });

  it("CONTROL: a deleted, UNBANNED account's address is free for a new signup", async () => {
    const user = await seedDeleted(false);

    const res = await resignup(user.email);

    expect(res.status).toBe(201);
    expect(res.headers.get("Set-Cookie")).toMatch(/^tj_session=/);
    await trackSignup(user.email);
  });

  it("once the ban is lifted and releaseReservedEmail runs, the address can sign up", async () => {
    const user = await seedDeleted(true);
    await expectEmailTaken(await resignup(user.email), user.email);

    const released = await (async () => {
      const ctx = createExecutionContext();
      const v = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
        await c.query("BEGIN");
        try {
          await c.query("UPDATE users SET disabled_at = NULL, disabled_reason = NULL WHERE id = $1", [user.userId]);
          const ok = await releaseReservedEmail(c, user.userId);
          await c.query("COMMIT");
          return ok;
        } catch (err) {
          try {
            await c.query("ROLLBACK");
          } catch {
            // keep the root error
          }
          throw err;
        }
      });
      await waitOnExecutionContext(ctx);
      return v;
    })();
    expect(released).toBe(true);

    const res = await resignup(user.email);

    expect(res.status).toBe(201);
    expect(res.headers.get("Set-Cookie")).toMatch(/^tj_session=/);
    await trackSignup(user.email);
  });
});
