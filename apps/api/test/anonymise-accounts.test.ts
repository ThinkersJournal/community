import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { anonymiseExpiredAccounts } from "../src/auth/anonymise-accounts";
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

/**
 * Same AC-3 reasoning as test/reap-unverified.test.ts: a barred account's
 * email/handle is exactly what a moderation/legal (CSAM/NCMEC) preservation
 * obligation may still need, so scrubbing it must wait until the bar lifts.
 */
describe("anonymiseExpiredAccounts — a barred account is never scrubbed", () => {
  it("spares disabled and suspended accounts while still scrubbing an ordinary one", async () => {
    const disabled = await seed({ requestedDaysAgo: 45, disabledAt: new Date() });
    const suspended = await seed({
      requestedDaysAgo: 45,
      suspendedUntil: new Date(Date.now() + 864e5),
    });
    const ordinary = await seed({ requestedDaysAgo: 45 });

    const ctx = createExecutionContext();
    await anonymiseExpiredAccounts(env, ctx);
    await waitOnExecutionContext(ctx);

    expect(
      (await row(disabled.id)).anonymisedAt,
      "a disabled account was scrubbed — its email/handle may still be needed for a moderation or preservation record",
    ).toBeNull();
    expect(
      (await row(suspended.id)).anonymisedAt,
      "a suspended account was scrubbed — same hazard as disabled above",
    ).toBeNull();
    // CONTROL, in the same pass: without it, "spared" is indistinguishable
    // from "the reaper scrubbed nothing at all".
    expect(
      (await row(ordinary.id)).anonymisedAt,
      "the reaper scrubbed nothing — the two guards above prove nothing",
    ).not.toBeNull();
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
