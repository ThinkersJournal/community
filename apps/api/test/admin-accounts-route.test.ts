import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { withClient } from "../src/db/client";

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";
const ALLOWED_ORIGIN = "http://localhost:8787";

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;
let sentEmails: Array<Record<string, unknown>> = [];
let capturedPurges: string[][] = [];
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
  capturedPurges = [];
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
  ])("400 INVALID_INPUT for %j", async (body) => {
    const { handle } = await seedHandle();
    const res = await act(handle, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT");
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
    await act(handle, { action: "ban", reason: "r" });
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
    expect((await act(handle, { action: "ban", reason: "r" })).status).toBe(200);
    const res = await act(handle, { action: "ban", reason: "again" });
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
  });

  it("401s without an Access assertion", async () => {
    const { handle } = await seedHandle();
    expect((await call(`/admin/accounts/${handle}`)).status).toBe(401);
  });
});
