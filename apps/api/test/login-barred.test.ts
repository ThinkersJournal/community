import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  it("⚠️ AC-4: a DISABLED account cannot log in with the correct password", async () => {
    const email = uniqueEmail();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    await insertUser(email, passwordHash);
    // Set disabled_at to now (permanent ban)
    await updateAccountStatus(email, new Date(), null);

    const res = await login(email, VALID_PASSWORD);
    expect(res.status).toBe(401);
  });

  it("⚠️ AC-4: a currently-SUSPENDED account cannot log in", async () => {
    const email = uniqueEmail();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    await insertUser(email, passwordHash);
    // Set suspended_until to 1 day in the future
    const future = new Date();
    future.setTime(future.getTime() + 24 * 60 * 60 * 1000);
    await updateAccountStatus(email, null, future);

    const res = await login(email, VALID_PASSWORD);
    expect(res.status).toBe(401);
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

  // CONTROL: without this, "401" would be indistinguishable from "the password
  // was wrong" or "this harness never logs anyone in".
  it("CONTROL: an ordinary account with the same password logs in fine", async () => {
    const otherEmail = uniqueEmail();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    await insertUser(otherEmail, passwordHash);

    const res = await login(otherEmail, VALID_PASSWORD);
    expect(res.status).toBe(200);
  });

  // ⚠️ NO ACCOUNT-STATE ORACLE: a barred account must be indistinguishable
  // from a wrong password. Login already refuses to enumerate users; barring
  // must not undo that.
  it("⚠️ a barred account returns the SAME body as a wrong password", async () => {
    const barredEmail = uniqueEmail();
    const otherEmail = uniqueEmail();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    await insertUser(barredEmail, passwordHash);
    await insertUser(otherEmail, passwordHash);

    // Bar the first account
    await updateAccountStatus(barredEmail, new Date(), null);

    const barred = await login(barredEmail, VALID_PASSWORD);
    const wrong = await login(otherEmail, "definitely-not-the-password");

    expect(barred.status).toBe(wrong.status);
    expect(await barred.json()).toEqual(await wrong.json());
  });
});
