import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, vi } from "vitest";

import { deviceHash, deviceHashes, type DeviceRecordMode } from "@thinkersjournal/shared";

import worker from "../../src";
import { hashPassword } from "../../src/auth/password";
import { withClient } from "../../src/db/client";
import type { UserSecurityDO } from "../../src/durable-objects/UserSecurityDO";
import type { NoticeClaimResult } from "../../src/security/user-devices";

import { quiet } from "./security-do";

/**
 * Shared fixtures for the account-holder notice tests (security-alerting spec
 * §4), split out of test/account-notices.test.ts so each concern has its own
 * file: account-notices-devices (the device list and keys),
 * account-notices-sends (caps, claims, in-flight sends and end states) and
 * account-notices-flows (the login, signup and reset flows).
 *
 * Postmark is intercepted the way test/forgot-password.test.ts does it
 * (`vi.stubGlobal("fetch")`); the stub reaches `UserSecurityDO` too, because the
 * pool runs the Durable Objects in the test's isolate.
 */
export const PASSWORD = "correct-horse-battery-staple";
export const ON: Env = { ...env, ACCOUNT_NOTICES_ENABLED: "1" };
export const DAY = 86_400_000;
export const created: string[] = [];

export interface Mail {
  to: string;
  subject: string;
  text: string;
}
/** Every mail Postmark accepted in this test (emptied before each). */
export const mails: Mail[] = [];
let postmarkStatus: { status: number; body: unknown } = { status: 200, body: { ErrorCode: 0 } };

/** What the Postmark stub answers for the rest of this test. */
export function setPostmarkStatus(next: { status: number; body: unknown }): void {
  postmarkStatus = next;
}

/**
 * The per-test Postmark stub and clean-up every account-notices file uses. Call
 * once at file scope, AFTER `guardAlertingFaults()` (the order the hooks had in
 * the single file this was split from).
 */
export function useNoticeTestHooks(): void {
  beforeEach(() => {
    mails.length = 0;
    postmarkStatus = { status: 200, body: { ErrorCode: 0 } };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith("https://api.postmarkapp.com/")) throw new Error(`unexpected fetch to ${url}`);
        const b = JSON.parse(typeof init?.body === "string" ? init.body : "") as { To: string; Subject: string; TextBody: string };
        if (postmarkStatus.status === 200) mails.push({ to: b.To, subject: b.Subject, text: b.TextBody });
        return Promise.resolve(new Response(JSON.stringify(postmarkStatus.body), { status: postmarkStatus.status }));
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("DELETE FROM users WHERE email = ANY($1)", [created.splice(0)]));
    await waitOnExecutionContext(ctx);
  });
}

export async function newUser(): Promise<{ email: string; id: string }> {
  const email = `notice_${crypto.randomUUID()}@example.test`;
  created.push(email);
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, await hashPassword(PASSWORD)],
    );
    return rows.at(0)?.id ?? "";
  });
  await waitOnExecutionContext(ctx);
  return { email, id };
}

export const tokenOf = (c: string) => c.padEnd(43, c).slice(0, 43);

/**
 * `quiet` for `UserSecurityDO`, with notices ON inside the object. The object
 * reads `ACCOUNT_NOTICES_ENABLED` from its OWN env at send time (final review
 * M-5), and the pool's env has it "0", so a test that drives a send turns it on
 * through the `noticesEnabled` seam.
 */
export function quietOn(u: Parameters<typeof quiet>[0] & Pick<UserSecurityDO, "noticesEnabled">): number[] {
  u.noticesEnabled = () => true;
  return quiet(u);
}
export const event = (atMs: number, country: string | null = null) => ({ atMs, country, listWasEmpty: false });
/** The route's handle on a send-now claim (review M-4); -1 for a deferred one. */
export const claimIdOf = (c: NoticeClaimResult) => (c.send === "now" ? c.claimId : -1);
export const HOUR = 3_600_000;

/** Every Postmark request the global `fetch` stub saw, refused ones included. */
export const postmarkCalls = () => vi.mocked(fetch).mock.calls.length;

/** Anonymise `id` the way the reaper leaves it: the address lookup then finds no live row. */
export async function anonymise(id: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("UPDATE users SET anonymised_at = now() WHERE id = $1", [id]));
  await waitOnExecutionContext(ctx);
}

/** A token for `userId` whose K1 hash sorts before (or after) its K2 hash: the order a `WITHOUT ROWID` scan returns. */
export async function tokenWithOrder(userId: string, prevFirst: boolean): Promise<string> {
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const t = tokenOf(c);
    if ((await deviceHash("K1", userId, t)) < (await deviceHash("K2", userId, t)) === prevFirst) return t;
  }
  throw new Error("no token with the wanted order in 26 tries");
}

/** A ledger stand-in that records each drop it is told about. */
export function dropRecorder(dropped: string[]) {
  return () => ({
    noticeDropped: (state: string) => {
      dropped.push(state);
      return Promise.resolve();
    },
  });
}

/**
 * Claim inside the object with its alarm seam replaced (audit I-5): a claim made
 * through the production stub arms a REAL alarm for about now, which would race
 * the test's explicit clock.
 */
export async function quietClaim(userId: string, atMs: number, notBeforeMs: number, country: string | null = null, listWasEmpty = false) {
  await runInDurableObject(env.USER_SECURITY.getByName(userId), async (u) => {
    quiet(u);
    await u.claimNotice("new_sign_in", { atMs, country, listWasEmpty }, atMs, notBeforeMs);
  });
}

/** Record `token`'s browser for `userId` under `keys`, inside the object with `armAt` replaced. */
export async function quietRecord(userId: string, token: string, mode: DeviceRecordMode, nowMs: number, keys = { current: "K1", prev: null as string | null }) {
  const hashes = await deviceHashes(keys, userId, token);
  return runInDurableObject(env.USER_SECURITY.getByName(userId), (u) => {
    quiet(u);
    return u.recordDevice(hashes, nowMs, mode);
  });
}

export function pendingRows(userId: string) {
  return runInDurableObject(env.USER_SECURITY.getByName(userId), (_u, s) =>
    s.storage.sql.exec<{ count: number; due_ms: number; attempts: number }>("SELECT count, due_ms, attempts FROM pending_notice").toArray(),
  );
}

export function deviceCount(userId: string): Promise<number> {
  return runInDurableObject(env.USER_SECURITY.getByName(userId), (_u, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM known_devices").one().n,
  );
}

export const ORIGIN = "https://community.thinkersjournal.com";
export const DEV_COOKIE = "tj_device_dev=";

/**
 * A per-call-unique client IP in its own /64 (the IPv6 documentation prefix), so
 * no login here shares LOGIN_IP_LIMITER's IP-only bucket (30 a minute) with
 * another, as test/login.test.ts does.
 */
export function uniqueIp(): string {
  const hex = crypto.randomUUID().replace(/-/g, "");
  return `2001:db8:${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}::1`;
}

/** POST /auth/login through the Worker; returns the response and the device token it carried or minted. */
export async function login(email: string, carried: string | null, e: Env = ON, ip = uniqueIp(), password = PASSWORD) {
  const ctx = createExecutionContext();
  const headers = new Headers({ "content-type": "application/json", Origin: ORIGIN, "X-TJ-Client-Country": "DE", "CF-Connecting-IP": ip });
  if (carried !== null) headers.set("Cookie", `${DEV_COOKIE}${carried}`);
  const res = await worker.fetch(
    new Request("https://api.test/auth/login", { method: "POST", headers, body: JSON.stringify({ email, password }) }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const minted = res.headers.getSetCookie().find((c) => c.startsWith(DEV_COOKIE));
  return { res, token: minted === undefined ? carried : (minted.split(";").at(0) ?? "").slice(DEV_COOKIE.length) };
}

/** Run a flow inside its own execution context, the way a route's waitUntil would. */
export async function flow(run: (ctx: ExecutionContext) => Promise<void>): Promise<void> {
  const ctx = createExecutionContext();
  await run(ctx);
  await waitOnExecutionContext(ctx);
}

/** A Hyperdrive binding whose connect always fails: the address lookup THROWS (CR-1). */
export const DEAD_DB = { ...ON, HYPERDRIVE_FRESH: { connectionString: "postgres://x:y@127.0.0.1:1/none" } } as Env;

/** Run the object's alarm at `atMs` with its alarm seam replaced. */
export async function quietAlarm(userId: string, atMs: number): Promise<void> {
  await runInDurableObject(env.USER_SECURITY.getByName(userId), async (u) => {
    quietOn(u);
    await u.alarmAt(atMs);
  });
}

export function pendingNotice(userId: string) {
  return runInDurableObject(env.USER_SECURITY.getByName(userId), (_u, s) =>
    s.storage.sql.exec<{ due_ms: number; count: number }>("SELECT due_ms, count FROM pending_notice").toArray(),
  );
}

/** POST /auth/login with exactly `cookie` as the Cookie header (or none). */
export async function loginWithCookie(email: string, cookie: string | null) {
  const ctx = createExecutionContext();
  const headers = new Headers({ "content-type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": uniqueIp() });
  if (cookie !== null) headers.set("Cookie", cookie);
  const res = await worker.fetch(
    new Request("https://api.test/auth/login", { method: "POST", headers, body: JSON.stringify({ email, password: PASSWORD }) }),
    ON,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
