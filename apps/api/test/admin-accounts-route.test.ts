import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { withClient } from "../src/db/client";

import { createVerifiedActor, deleteCreatedUsers } from "./actor";

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";
const ALLOWED_ORIGIN = "http://localhost:8787";

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;
let sentEmails: Array<Record<string, unknown>> = [];
let createdUserIds: string[] = [];
let adminEmail: string;

async function makeJwt(claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64urlJson({
    iss: `https://${TEAM}`, aud: [AUD], sub: "user-sub-1",
    email: adminEmail, exp: now + 600, ...claims,
  });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  sentEmails = [];
  createdUserIds = [];
  adminEmail = `mod-${crypto.randomUUID()}@example.test`;
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  __resetJwksCacheForTests();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.postmarkapp.com/email") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sentEmails.push(body);
      return new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Default: return JWKS for Access JWT verification
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(async () => {
  // Clean up created users to prevent accumulation
  if (createdUserIds.length > 0) {
    await ctxRun(async (c) => {
      await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]);
    });
  }
  await deleteCreatedUsers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    [{ action: "ban", reason: "r" }],
    [{ action: "ban", reason: "r", confirmBan: false }],
  ])("400 INVALID_INPUT for %j", async (body) => {
    const { handle } = await seedHandle();
    const res = await act(handle, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  // CONTROL for the two `ban` rows just above: the identical body, PLUS
  // confirmBan: true, succeeds — without this, "400" is indistinguishable
  // from "ban is broken outright".
  it("CONTROL: ban with confirmBan: true is NOT rejected for lacking confirmation", async () => {
    const { handle } = await seedHandle();
    const res = await act(handle, { action: "ban", reason: "r", confirmBan: true });
    expect(res.status).toBe(200);
  });

  // warn/suspend need no confirmBan at all — only `ban` is gated.
  it("warn and suspend are unaffected by the confirmBan gate", async () => {
    const warnTarget = await seedHandle();
    const suspendTarget = await seedHandle();
    expect((await act(warnTarget.handle, { action: "warn", reason: "r" })).status).toBe(200);
    expect((await act(suspendTarget.handle, { action: "suspend", reason: "r" })).status).toBe(200);
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
    await act(handle, { action: "ban", reason: "r", confirmBan: true });
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
    expect((await act(handle, { action: "ban", reason: "r", confirmBan: true })).status).toBe(200);
    const res = await act(handle, { action: "ban", reason: "again", confirmBan: true });
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
    expect(body.disabledReason).toBeNull();
  });

  it("401s without an Access assertion", async () => {
    const { handle } = await seedHandle();
    expect((await call(`/admin/accounts/${handle}`)).status).toBe(401);
  });

  it("disabledReason mirrors users.disabled_reason once the account is banned", async () => {
    const { handle } = await seedHandle();
    expect((await act(handle, { action: "ban", reason: "r", confirmBan: true })).status).toBe(200);
    const res = await call(`/admin/accounts/${handle}`, { headers: { "Cf-Access-Jwt-Assertion": await makeJwt() } });
    const body = (await res.json()) as import("@thinkersjournal/shared").AdminAccountResponse;
    expect(body.disabledReason).toBe("ban");
  });
});

describe("POST /admin/accounts/:handle/actions — notice emails (Review Focus 2)", () => {
  it.each(["warn", "suspend", "ban"] as const)(
    "%s sends exactly one notice email, To the seeded address, on the outbound stream",
    async (action) => {
      const { handle, email } = await seedHandle();
      const res = await act(handle, { action, reason: "r", confirmBan: true });
      expect(res.status).toBe(200);
      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0]).toMatchObject({ To: email, MessageStream: "outbound" });
    },
  );

  it("a suspend notice's TextBody carries the suspension's end date (UTC string)", async () => {
    const { handle, userId } = await seedHandle();
    expect((await act(handle, { action: "suspend", reason: "r" })).status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    const until = await ctxRun(
      async (c) => (await c.query<{ s: Date }>(`SELECT suspended_until AS s FROM users WHERE id = $1`, [userId])).rows[0]!.s,
    );
    expect(String(sentEmails[0]!.TextBody)).toContain(until.toUTCString());
  });

  it("a 409 ACCOUNT_ALREADY_DISABLED (second ban) sends zero emails for that call", async () => {
    const { handle } = await seedHandle();
    expect((await act(handle, { action: "ban", reason: "r", confirmBan: true })).status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    sentEmails.length = 0;
    const res = await act(handle, { action: "ban", reason: "again", confirmBan: true });
    expect(res.status).toBe(409);
    expect(sentEmails).toHaveLength(0);
  });

  it("⚠️ Review Focus 5: an anonymised account (still-present handle) 404s and sends zero emails", async () => {
    const { handle, userId } = await seedHandle();
    // The handle is STILL PRESENT in profiles (anonymise-accounts only
    // releases it 30 days later) — anonymised_at alone is what 404s it.
    await ctxRun((c) => c.query(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [userId]));
    const res = await act(handle, { action: "warn", reason: "r" });
    expect(res.status).toBe(404);
    expect(sentEmails).toHaveLength(0);
  });
});

describe("⚠️ a member session grants no admin authority (Review Focus 3 scope)", () => {
  afterEach(async () => {
    await deleteCreatedUsers();
  });

  it("GET /admin/accounts/:handle — a verified member's own session Cookie, no Access header, 401s", async () => {
    const { handle } = await seedHandle();
    const member = await createVerifiedActor();
    const res = await call(`/admin/accounts/${handle}`, { headers: { Cookie: member.cookie } });
    expect(res.status).toBe(401);
  });

  it("POST /admin/accounts/:handle/actions — same session + Origin, no Access header, 401s", async () => {
    const { handle } = await seedHandle();
    const member = await createVerifiedActor();
    const res = await call(`/admin/accounts/${handle}/actions`, {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: member.cookie },
      body: JSON.stringify({ action: "warn", reason: "r" }),
    });
    expect(res.status).toBe(401);
  });
});
