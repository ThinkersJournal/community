import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { withClient } from "../src/db/client";
import { peekActionToken } from "../src/moderation/action-tokens";
import { applyAccountAction } from "../src/moderation/account-actions";
import { enqueueAppealOutcomeNotice } from "../src/moderation/notice-enqueue";
import { drainNoticeOutbox } from "../src/moderation/notice-outbox";
import { listUndeliveredNotices, resendNotice } from "../src/moderation/notice-resend";

import type { Client } from "pg";

/**
 * Notice outbox PR 3 — the undelivered-notices list and RESEND, against the real
 * database; the route is driven through the Worker with an Access JWT.
 */
const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";
const ALLOWED_ORIGIN = "http://localhost:8787";
const ORIGIN = "https://community.test";

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;
let sentEmails: Array<Record<string, unknown>> = [];
const userIds: string[] = [];
const actionIds: string[] = [];
const rowIds: string[] = [];

async function makeJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64urlJson({ iss: `https://${TEAM}`, aud: [AUD], sub: "sub-1", email: `mod-${crypto.randomUUID()}@example.test`, exp: now + 600 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

async function run<T>(fn: (c: Client) => Promise<T>): Promise<T> {
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
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  __resetJwksCacheForTests();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://api.postmarkapp.com/email") {
      sentEmails.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "test" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(async () => {
  await run(async (c) => {
    await c.query(`DELETE FROM moderation_notice_outbox WHERE id = ANY($1::uuid[]) OR action_id = ANY($2::uuid[])`, [rowIds, actionIds]);
    await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
  });
  rowIds.length = 0;
  actionIds.length = 0;
  userIds.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mkUser(anonymised = false): Promise<string> {
  const id = crypto.randomUUID();
  const handle = `rs${id.replace(/-/g, "").slice(0, 16)}`;
  await run(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at, anonymised_at) VALUES ($1, $2, 'h', now(), ${anonymised ? "now()" : "NULL"})`,
      [id, `${handle}@resend.test`],
    );
    await c.query(`INSERT INTO profiles (user_id, username) VALUES ($1, $2)`, [id, handle]);
  });
  userIds.push(id);
  return id;
}

/** A real ban with its notice queued (tokens and links included), then forced to `undeliverable`. */
async function undeliverableBan(userId: string): Promise<{ rowId: string; actionId: string }> {
  const out = await run((c) =>
    applyAccountAction(c, { userId, kind: "ban", reason: "r", actorAdmin: "mod@example.test", subjectLabel: "x", enqueueNotice: { origin: ORIGIN } }),
  );
  if (out.kind !== "applied") throw new Error("not applied");
  actionIds.push(out.actionId);
  const rowId = await run(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `UPDATE moderation_notice_outbox SET state = 'undeliverable', attempts = 7, last_error = 'retries_exhausted:transport'
        WHERE action_id = $1 RETURNING id`,
      [out.actionId],
    );
    return rows[0]!.id;
  });
  rowIds.push(rowId);
  return { rowId, actionId: out.actionId };
}

async function rowOf(id: string) {
  return run(async (c) => {
    const { rows } = await c.query<{ state: string; attempts: number; last_error: string | null; body_text: string; body_html: string }>(
      `SELECT state, attempts, last_error, body_text, body_html FROM moderation_notice_outbox WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  });
}

const tokensIn = (body: string): string[] => [...body.matchAll(/\?token=([A-Za-z0-9_%~-]+)/g)].map((m) => decodeURIComponent(m[1]!));

describe("listUndeliveredNotices", () => {
  it("lists undeliverable rows only, with the handle and no body; resendable reflects the recipient", async () => {
    const live = await mkUser();
    const { rowId } = await undeliverableBan(live);
    // A pending row for another account must not appear (control: it exists).
    const other = await mkUser();
    const pending = await run((c) =>
      applyAccountAction(c, { userId: other, kind: "warn", reason: "r", actorAdmin: "mod@example.test", subjectLabel: "x", enqueueNotice: { origin: ORIGIN } }),
    );
    if (pending.kind !== "applied") throw new Error("not applied");
    actionIds.push(pending.actionId);

    const list = await run((c) => listUndeliveredNotices(c));
    const mine = list.find((n) => n.id === rowId);
    expect(mine).toMatchObject({ kind: "account_action", attempts: 7, lastError: "retries_exhausted:transport", resendable: true });
    expect(mine!.recipientHandle).toMatch(/^rs/);
    expect(JSON.stringify(mine)).not.toContain("?token=");
    expect(list.some((n) => n.actionId === pending.actionId)).toBe(false);

    // Anonymising the recipient makes it not resendable.
    await run((c) => c.query(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [live]));
    const after = await run((c) => listUndeliveredNotices(c));
    expect(after.find((n) => n.id === rowId)?.resendable).toBe(false);
  });
});

describe("resendNotice", () => {
  it("returns the row to pending with FRESH tokens swapped into text and html; the new links work", async () => {
    const userId = await mkUser();
    const { rowId, actionId } = await undeliverableBan(userId);
    const before = await rowOf(rowId);
    const oldTokens = tokensIn(before.body_text);
    expect(oldTokens, "control: a ban notice carries an appeal and a delete-request link").toHaveLength(2);

    expect(await run((c) => resendNotice(c, rowId, ORIGIN))).toEqual({ kind: "resent" });
    const after = await rowOf(rowId);
    expect(after).toMatchObject({ state: "pending", attempts: 0, last_error: null });
    const newTokens = tokensIn(after.body_text);
    expect(newTokens).toHaveLength(2);
    for (const t of oldTokens) {
      expect(after.body_text).not.toContain(t);
      expect(after.body_html).not.toContain(t);
    }
    for (const t of newTokens) expect(after.body_html).toContain(t);
    const appealToken = after.body_text.match(/\/appeal\?token=([A-Za-z0-9_%~-]+)/)![1]!;
    expect(await run((c) => peekActionToken(c, decodeURIComponent(appealToken), "appeal"))).toMatchObject({ actionId, userId });

    // The drain then sends it, to the account's address, and strips the live links.
    const ctx = createExecutionContext();
    await drainNoticeOutbox(env, ctx, { onlyActionIds: [actionId] });
    await waitOnExecutionContext(ctx);
    expect(sentEmails).toHaveLength(1);
    expect(String(sentEmails[0]!.TextBody)).toContain(newTokens[0]!);
    expect((await rowOf(rowId)).state).toBe("delivered");
  });

  it("a notice with no links (an appeal outcome) is resent unchanged", async () => {
    const userId = await mkUser();
    const resolutionActionId = crypto.randomUUID();
    actionIds.push(resolutionActionId);
    await run((c) => enqueueAppealOutcomeNotice(c, { resolutionActionId, appellantId: userId, outcome: "denied", reason: "no" }));
    const rowId = await run(async (c) => (await c.query<{ id: string }>(
      `UPDATE moderation_notice_outbox SET state = 'undeliverable' WHERE action_id = $1 RETURNING id`, [resolutionActionId])).rows[0]!.id);
    rowIds.push(rowId);
    const before = await rowOf(rowId);
    expect(await run((c) => resendNotice(c, rowId, ORIGIN))).toEqual({ kind: "resent" });
    const after = await rowOf(rowId);
    expect(after.state).toBe("pending");
    expect(after.body_text).toBe(before.body_text);
  });

  it("refuses a reporter row, an anonymised recipient, a row that is not undeliverable, and an unknown id", async () => {
    const reporterAction = crypto.randomUUID();
    actionIds.push(reporterAction);
    const reporterRow = await run(async (c) => (await c.query<{ id: string }>(
      `INSERT INTO moderation_notice_outbox (action_id, kind, subject, body_text, body_html, state, retain_until, dsa_notice_id)
       VALUES ($1, 'reporter_outcome', 's', 't', '<p>t</p>', 'undeliverable', now() + interval '1 day', $2) RETURNING id`,
      [reporterAction, crypto.randomUUID()])).rows[0]!.id);
    rowIds.push(reporterRow);
    expect(await run((c) => resendNotice(c, reporterRow, ORIGIN))).toEqual({ kind: "not_resendable" });
    expect((await rowOf(reporterRow)).state, "a refusal changes nothing").toBe("undeliverable");

    const gone = await mkUser();
    const { rowId } = await undeliverableBan(gone);
    await run((c) => c.query(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [gone]));
    expect(await run((c) => resendNotice(c, rowId, ORIGIN))).toEqual({ kind: "not_resendable" });
    expect((await rowOf(rowId)).state).toBe("undeliverable");

    const live = await mkUser();
    const second = await undeliverableBan(live);
    await run((c) => c.query(`UPDATE moderation_notice_outbox SET state = 'delivered' WHERE id = $1`, [second.rowId]));
    expect(await run((c) => resendNotice(c, second.rowId, ORIGIN))).toEqual({ kind: "not_found" });
    expect(await run((c) => resendNotice(c, crypto.randomUUID(), ORIGIN))).toEqual({ kind: "not_found" });
  });
});

describe("the admin routes", () => {
  async function post(id: string, headers: Record<string, string> = {}): Promise<Response> {
    return call(`/admin/notices/${id}/resend`, {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, "Cf-Access-Jwt-Assertion": await makeJwt(), ...headers },
    });
  }

  it("GET needs Access; POST 403s a cross-site origin first, 401s without Access, 404s a malformed id", async () => {
    expect((await call("/admin/notices/undelivered")).status).toBe(401);
    expect((await call("/admin/notices/undelivered", { headers: { "Cf-Access-Jwt-Assertion": await makeJwt() } })).status).toBe(200);
    const id = crypto.randomUUID();
    expect((await post(id, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await call(`/admin/notices/${id}/resend`, { method: "POST", headers: { Origin: ALLOWED_ORIGIN } })).status).toBe(401);
    expect((await post("not-a-uuid")).status).toBe(404);
    expect((await post(id)).status).toBe(404);
  });

  it("resends an undeliverable notice (200 {id}); a reporter row is 409 NOT_RESENDABLE", async () => {
    const userId = await mkUser();
    const { rowId } = await undeliverableBan(userId);
    const res = await post(rowId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: rowId });
    expect((await rowOf(rowId)).state).toBe("pending");
    // Resending again is a 404: it is no longer undeliverable.
    expect((await post(rowId)).status).toBe(404);

    const reporterAction = crypto.randomUUID();
    actionIds.push(reporterAction);
    const reporterRow = await run(async (c) => (await c.query<{ id: string }>(
      `INSERT INTO moderation_notice_outbox (action_id, kind, subject, body_text, body_html, state, retain_until, dsa_notice_id)
       VALUES ($1, 'reporter_outcome', 's', 't', '<p>t</p>', 'undeliverable', now() + interval '1 day', $2) RETURNING id`,
      [reporterAction, crypto.randomUUID()])).rows[0]!.id);
    rowIds.push(reporterRow);
    const refused = await post(reporterRow);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("NOT_RESENDABLE");
  });
});
