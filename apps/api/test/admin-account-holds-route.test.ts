import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { withClient } from "../src/db/client";

import { deleteCreatedUsers } from "./actor";

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";
const ALLOWED_ORIGIN = "http://localhost:8787";

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;
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
      return new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(async () => {
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

async function impose(
  handle: string,
  body: unknown,
  headers: Record<string, string> = {},
  jwtClaims: Record<string, unknown> = {},
): Promise<Response> {
  return call(`/admin/accounts/${handle}/holds`, {
    method: "POST",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      "Cf-Access-Jwt-Assertion": await makeJwt(jwtClaims),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function release(
  handle: string,
  holdId: string,
  body: unknown,
  headers: Record<string, string> = {},
  jwtClaims: Record<string, unknown> = {},
): Promise<Response> {
  return call(`/admin/accounts/${handle}/holds/${holdId}/release`, {
    method: "POST",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      "Cf-Access-Jwt-Assertion": await makeJwt(jwtClaims),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function seedCsamHold(userId: string): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO account_legal_holds (user_id, category, imposed_by, reason)
       VALUES ($1, 'csam', 'system', 'seeded csam hold') RETURNING id`,
      [userId],
    );
    return rows[0]!.id;
  });
}

describe("POST /admin/accounts/:handle/holds", () => {
  it("403s a cross-site origin BEFORE the Access check", async () => {
    const { handle } = await seedHandle();
    const res = await impose(handle, { category: "dmca", reason: "r" }, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("401s without an Access assertion", async () => {
    const { handle } = await seedHandle();
    const res = await call(`/admin/accounts/${handle}/holds`, {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ category: "dmca", reason: "r" }),
    });
    expect(res.status).toBe(401);
  });

  it("imposing a dmca hold succeeds and the hold is active", async () => {
    const { handle, userId } = await seedHandle();
    const res = await impose(handle, { category: "dmca", reason: "a dmca notice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: boolean; holdId: string };
    expect(body.created).toBe(true);
    const rows = await ctxRun((c) =>
      c.query(`SELECT 1 FROM account_legal_holds WHERE id = $1 AND user_id = $2 AND released_at IS NULL`, [body.holdId, userId]),
    );
    expect(rows.rowCount).toBe(1);
  });

  it("400 INVALID_INPUT for category csam", async () => {
    const { handle } = await seedHandle();
    const res = await impose(handle, { category: "csam", reason: "r" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it("400 INVALID_INPUT for a blank reason", async () => {
    const { handle } = await seedHandle();
    const res = await impose(handle, { category: "dmca", reason: "   " });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it("404 for an unknown handle", async () => {
    const res = await impose("nobody-at-all-here", { category: "dmca", reason: "r" });
    expect(res.status).toBe(404);
  });

  it("a duplicate impose of the same category answers created:false with exactly one log row", async () => {
    const { handle, userId } = await seedHandle();
    const first = await impose(handle, { category: "dmca", reason: "first" });
    expect(first.status).toBe(200);
    const second = await impose(handle, { category: "dmca", reason: "second" });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { created: boolean };
    expect(body.created).toBe(false);
    const rows = await ctxRun((c) =>
      c.query(`SELECT 1 FROM moderation_actions WHERE subject_user_id = $1 AND action = 'account_hold'`, [userId]),
    );
    expect(rows.rowCount).toBe(1);
  });
});

describe("POST /admin/accounts/:handle/holds/:id/release", () => {
  it("403s a cross-site origin BEFORE the Access check", async () => {
    const { handle } = await seedHandle();
    const res = await release(handle, "00000000-0000-7000-8000-000000000000", { reason: "r" }, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("401s without an Access assertion", async () => {
    const { handle } = await seedHandle();
    const res = await call(`/admin/accounts/${handle}/holds/00000000-0000-7000-8000-000000000000/release`, {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ reason: "r" }),
    });
    expect(res.status).toBe(401);
  });

  it("404s a non-UUID id before any query", async () => {
    const { handle } = await seedHandle();
    const res = await release(handle, "not-a-uuid", { reason: "r" });
    expect(res.status).toBe(404);
  });

  it("release by a SECOND admin succeeds", async () => {
    const { handle } = await seedHandle();
    const imposeRes = await impose(handle, { category: "dmca", reason: "r" }, {}, { email: adminEmail });
    const { holdId } = (await imposeRes.json()) as { holdId: string };
    const secondAdminEmail = `mod2-${crypto.randomUUID()}@example.test`;
    const res = await release(handle, holdId, { reason: "released" }, {}, { email: secondAdminEmail });
    expect(res.status).toBe(200);
    const rows = await ctxRun((c) =>
      c.query(`SELECT released_at FROM account_legal_holds WHERE id = $1`, [holdId]),
    );
    expect(rows.rows[0]!.released_at).not.toBeNull();
  });

  it("release by the SAME admin who imposed it is 403", async () => {
    const { handle } = await seedHandle();
    const imposeRes = await impose(handle, { category: "dmca", reason: "r" });
    const { holdId } = (await imposeRes.json()) as { holdId: string };
    const res = await release(handle, holdId, { reason: "nope" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("FORBIDDEN");
  });

  it("release of a csam hold is 409 HOLD_NOT_RELEASABLE", async () => {
    const { handle, userId } = await seedHandle();
    const holdId = await seedCsamHold(userId);
    const res = await release(handle, holdId, { reason: "nope" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("HOLD_NOT_RELEASABLE");
  });

  it("a hold belonging to a DIFFERENT user under this handle is 404, and the hold stays active", async () => {
    const { handle } = await seedHandle();
    const other = await seedHandle();
    const imposeRes = await impose(other.handle, { category: "dmca", reason: "r" }, {}, { email: `mod3-${crypto.randomUUID()}@example.test` });
    const { holdId } = (await imposeRes.json()) as { holdId: string };
    const res = await release(handle, holdId, { reason: "nope" }, {}, { email: `mod4-${crypto.randomUUID()}@example.test` });
    expect(res.status).toBe(404);
    const rows = await ctxRun((c) =>
      c.query(`SELECT released_at FROM account_legal_holds WHERE id = $1`, [holdId]),
    );
    expect(rows.rows[0]!.released_at).toBeNull();
  });
});

describe("GET /admin/accounts/:handle — holds", () => {
  it("shows active holds", async () => {
    const { handle } = await seedHandle();
    const imposeRes = await impose(handle, { category: "dmca", reason: "a reason" });
    expect(imposeRes.status).toBe(200);
    const res = await call(`/admin/accounts/${handle}`, { headers: { "Cf-Access-Jwt-Assertion": await makeJwt() } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as import("@thinkersjournal/shared").AdminAccountResponse;
    expect(body.holds).toHaveLength(1);
    expect(body.holds[0]!.category).toBe("dmca");
    expect(body.holds[0]!.reason).toBe("a reason");
    expect(body.holds[0]!.releasedAt).toBeNull();
  });
});
