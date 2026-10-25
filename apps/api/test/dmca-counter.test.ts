// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { withClient } from "../src/db/client";
import { addBusinessDays, restoreDueDmcaNotices } from "../src/moderation/dmca-counter";
import { applyDecision } from "../src/moderation/decide";
import { imposeAccountHoldInTx } from "../src/moderation/account-holds";

/**
 * The counter-notice half of the DMCA flow (ROADMAP R9, PR 3): the author's
 * counter-notice, its forward to the claimant, the restore timer, and the two
 * moderator records (the claimant filed suit; the claimant withdrew).
 * Helpers follow dmca-decisions.test.ts.
 */

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";
const ALLOWED_ORIGIN = "http://localhost:8787";

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;
let createdUserIds: string[] = [];
let createdNoticeIds: string[] = [];
let adminEmail: string;
let n = 0;

async function makeJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64urlJson({ iss: `https://${TEAM}`, aud: [AUD], sub: "user-sub-1", email: adminEmail, exp: now + 600 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
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

async function adminPost(path: string, body?: unknown): Promise<Response> {
  return call(path, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await makeJwt(), Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A fresh TEST-NET-3 address per call: the counter route's limiter is per IP. */
function ip(): string {
  n += 1;
  return `203.0.113.${(n * 7 + Math.floor(Math.random() * 100)) % 250 + 1}`;
}

function postCounter(body: unknown, headers: Record<string, string> = { Origin: ALLOWED_ORIGIN }): Promise<Response> {
  return call("/dmca-counter", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": ip(), ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  createdUserIds = [];
  createdNoticeIds = [];
  adminEmail = `mod-${crypto.randomUUID()}@example.test`;
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  __resetJwksCacheForTests();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://api.postmarkapp.com/email") {
      return new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "t" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(async () => {
  await ctxRun(async (c) => {
    await c.query(`DELETE FROM dmca_notices WHERE id = ANY($1::uuid[])`, [createdNoticeIds]);
    await c.query(
      `DELETE FROM moderation_notice_outbox
        WHERE recipient_user_id = ANY($1::uuid[]) OR action_id = ANY($2::uuid[])
           OR action_id IN (SELECT id FROM moderation_actions WHERE subject_user_id = ANY($1::uuid[]))`,
      [createdUserIds, createdNoticeIds],
    );
    await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]);
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function seedUser(): Promise<string> {
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, 'x', now()) RETURNING id`,
      [`test-${crypto.randomUUID()}@example.com`],
    );
    return rows[0]!.id;
  });
  createdUserIds.push(id);
  return id;
}

async function seedPost(userId: string): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, $2, $3, 'test content', 'published', now()) RETURNING id`,
      [userId, "test post " + crypto.randomUUID().slice(0, 8), "test-" + crypto.randomUUID().slice(0, 8)],
    );
    return rows[0]!.id;
  });
}

async function seedConfirmedNotice(postId: string): Promise<string> {
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO dmca_notices
         (complainant_email, complainant_name, complainant_address, complainant_phone, signature, work_description,
          statement_good_faith, statement_accuracy, verify_token_hash, target_kind, target_label, post_id, email_verified_at)
       VALUES ($1, 'Jane Owner', '1 Example Street', '+1 555 0100', 'Jane Owner', 'My essay',
               true, true, $2, 'post', 'a label', $3, now()) RETURNING id`,
      [`claimant-${crypto.randomUUID()}@example.test`, `hash-${crypto.randomUUID()}`, postId],
    );
    return rows[0]!.id;
  });
  createdNoticeIds.push(id);
  return id;
}

interface Taken { userId: string; postId: string; noticeId: string; actionId: string; token: string }

/** A real takedown through the route; the counter token is read from the queued author notice. */
async function takenDown(): Promise<Taken> {
  const userId = await seedUser();
  const postId = await seedPost(userId);
  const noticeId = await seedConfirmedNotice(postId);
  const res = await adminPost(`/admin/dmca-notices/${noticeId}/takedown`);
  expect(res.status).toBe(200);
  const { actionId } = (await res.json()) as { actionId: string };
  const body = await ctxRun(async (c) =>
    (await c.query<{ body_text: string }>(
      `SELECT body_text FROM moderation_notice_outbox WHERE action_id = $1 AND kind = 'dmca_author_notice'`,
      [actionId],
    )).rows[0]!.body_text,
  );
  const m = /\/dmca\/counter\?token=([A-Za-z0-9_%~-]+)/.exec(body);
  expect(m, "no counter link").not.toBeNull();
  return { userId, postId, noticeId, actionId, token: decodeURIComponent(m![1]!) };
}

const COUNTER = {
  authorName: "A. Author",
  authorAddress: "2 Example Road, Exampleton",
  authorPhone: "+1 555 0101",
  signature: "A. Author",
  statementMistake: true,
  consentJurisdiction: true,
};

interface NoticeRow { state: string; restore_after: Date | null; counter_token_hash: string | null; restored_at: Date | null; claimant_sued_at: Date | null }
const noticeRow = (id: string) =>
  ctxRun(async (c) =>
    (await c.query<NoticeRow>(`SELECT state, restore_after, counter_token_hash, restored_at, claimant_sued_at FROM dmca_notices WHERE id = $1`, [id])).rows[0]!,
  );
const hiddenAt = (postId: string) =>
  ctxRun(async (c) => (await c.query<{ h: Date | null }>(`SELECT hidden_at AS h FROM posts WHERE id = $1`, [postId])).rows[0]!.h);
const makeDue = (id: string) =>
  ctxRun((c) => c.query(`UPDATE dmca_notices SET restore_after = now() - interval '1 minute' WHERE id = $1`, [id]));

async function runTimer(): Promise<number> {
  const ctx = createExecutionContext();
  const restored = await restoreDueDmcaNotices(env, ctx);
  await waitOnExecutionContext(ctx);
  return restored;
}

describe("addBusinessDays", () => {
  it("skips weekends", () => {
    // 2026-10-23 is a Friday.
    expect(addBusinessDays(new Date("2026-10-23T12:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-10-26");
    expect(addBusinessDays(new Date("2026-10-21T12:00:00Z"), 10).toISOString().slice(0, 10)).toBe("2026-11-04");
    expect(addBusinessDays(new Date("2026-10-24T12:00:00Z"), 0).toISOString().slice(0, 10)).toBe("2026-10-24");
  });
});

describe("the counter-notice", () => {
  it("peeks, files once, moves the notice to counter_received with a restore date, and forwards it to the claimant", async () => {
    const t = await takenDown();

    const peek = await call(`/dmca-counter?token=${encodeURIComponent(t.token)}`);
    expect(peek.status).toBe(200);
    expect(((await peek.json()) as { kind: string }).kind).toBe("post");
    // A peek changes nothing.
    expect((await noticeRow(t.noticeId)).state).toBe("taken_down");

    const filed = await postCounter({ token: t.token, ...COUNTER });
    expect(filed.status).toBe(200);

    const row = await noticeRow(t.noticeId);
    expect(row.state).toBe("counter_received");
    expect(row.counter_token_hash).toBeNull();
    // 10 business days is 12 to 14 calendar days depending on the weekday it starts on, and lands on a weekday.
    const days = (row.restore_after!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(11.5);
    expect(days).toBeLessThan(14.5);
    expect([0, 6]).not.toContain(row.restore_after!.getUTCDay());

    const counter = await ctxRun(async (c) =>
      (await c.query(`SELECT id, author_name, statement_mistake, consent_jurisdiction FROM dmca_counter_notices WHERE notice_id = $1`, [t.noticeId])).rows,
    );
    expect(counter).toHaveLength(1);
    const forward = await ctxRun(async (c) =>
      (await c.query<{ kind: string; recipient_email: string; body_text: string }>(
        `SELECT kind, recipient_email, body_text FROM moderation_notice_outbox WHERE action_id = $1`,
        [counter[0]!.id],
      )).rows,
    );
    expect(forward).toHaveLength(1);
    expect(forward[0]!.kind).toBe("dmca_claimant_notice");
    expect(forward[0]!.body_text).toContain("A. Author");
    expect(forward[0]!.body_text).toContain("2 Example Road");
    expect(forward[0]!.body_text).toContain("filed a court action");

    // The token is single-use: a second filing and a second peek both fail alike.
    const again = await postCounter({ token: t.token, ...COUNTER });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { code: string }).code).toBe("INVALID_TOKEN");
    expect((await call(`/dmca-counter?token=${encodeURIComponent(t.token)}`)).status).toBe(400);
  });

  it("refuses a missing statement (naming the field), an unknown token, and a foreign Origin", async () => {
    const t = await takenDown();
    for (const field of ["statementMistake", "consentJurisdiction"] as const) {
      const res = await postCounter({ token: t.token, ...COUNTER, [field]: false });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { fields?: string[] }).fields).toContain(field);
    }
    expect((await postCounter({ token: "not-a-real-token", ...COUNTER })).status).toBe(400);
    expect((await postCounter({ token: t.token, ...COUNTER }, { Origin: "https://evil.example" })).status).toBe(403);
    // Nothing above used the token up.
    expect((await noticeRow(t.noticeId)).state).toBe("taken_down");
  });
});

describe("the restore timer", () => {
  it("restores a counter-noticed post whose wait is over: system content_restore, notice restored, both emails queued", async () => {
    const t = await takenDown();
    expect(await hiddenAt(t.postId)).not.toBeNull();
    expect((await postCounter({ token: t.token, ...COUNTER })).status).toBe(200);

    // Not yet due: the timer leaves it alone.
    await runTimer();
    expect(await hiddenAt(t.postId)).not.toBeNull();

    await makeDue(t.noticeId);
    expect(await runTimer()).toBeGreaterThanOrEqual(1);

    expect(await hiddenAt(t.postId)).toBeNull();
    expect((await noticeRow(t.noticeId)).state).toBe("restored");
    const action = await ctxRun(async (c) =>
      (await c.query(
        `SELECT id, action, actor_admin, source, dmca_notice_id FROM moderation_actions
          WHERE post_id = $1 AND action = 'content_restore'`,
        [t.postId],
      )).rows[0],
    );
    expect(action).toMatchObject({ action: "content_restore", actor_admin: "system", source: "dmca_notice", dmca_notice_id: t.noticeId });
    const kinds = await ctxRun(async (c) =>
      (await c.query<{ kind: string }>(`SELECT kind FROM moderation_notice_outbox WHERE action_id = $1 ORDER BY kind`, [action!.id])).rows.map((r) => r.kind),
    );
    expect(kinds).toEqual(["dmca_author_notice", "dmca_claimant_notice"]);
  });

  it("does not restore once a moderator records that the claimant filed suit (and says so once)", async () => {
    const t = await takenDown();
    expect((await postCounter({ token: t.token, ...COUNTER })).status).toBe(200);
    expect((await adminPost(`/admin/dmca-notices/${t.noticeId}/claimant-sued`)).status).toBe(204);
    expect((await adminPost(`/admin/dmca-notices/${t.noticeId}/claimant-sued`)).status).toBe(409);

    await makeDue(t.noticeId);
    await runTimer();
    expect(await hiddenAt(t.postId)).not.toBeNull();
    const row = await noticeRow(t.noticeId);
    expect(row.state).toBe("counter_received");
    expect(row.claimant_sued_at).not.toBeNull();
  });

  it("leaves a held author's content for a person", async () => {
    const t = await takenDown();
    expect((await postCounter({ token: t.token, ...COUNTER })).status).toBe(200);
    await ctxRun(async (c) => {
      await c.query("BEGIN");
      await imposeAccountHoldInTx(c, { userId: t.userId, category: "other", imposedBy: adminEmail, reason: "test hold" });
      await c.query("COMMIT");
    });
    await makeDue(t.noticeId);
    await runTimer();
    expect(await hiddenAt(t.postId)).not.toBeNull();
    expect((await noticeRow(t.noticeId)).state).toBe("counter_received");
  });

  it("never overrides a later human ruling: the notice is closed, the post stays hidden", async () => {
    const t = await takenDown();
    expect((await postCounter({ token: t.token, ...COUNTER })).status).toBe(200);
    // A different moderator rules on the same post after the takedown.
    await ctxRun((c) =>
      applyDecision(c, { subject: "post", subjectId: t.postId, decision: "keep_hidden", reason: "Also breaks the Guidelines.", actorAdmin: "other-mod@example.test" }),
    );
    await makeDue(t.noticeId);
    await runTimer();
    expect(await hiddenAt(t.postId)).not.toBeNull();
    expect((await noticeRow(t.noticeId)).state).toBe("withdrawn");
  });
});

describe("POST /admin/dmca-notices/:id/withdraw", () => {
  it("restores at once from a standing takedown and records the notice as withdrawn", async () => {
    const t = await takenDown();
    const res = await adminPost(`/admin/dmca-notices/${t.noticeId}/withdraw`);
    expect(res.status).toBe(200);
    expect(await hiddenAt(t.postId)).toBeNull();
    const row = await noticeRow(t.noticeId);
    expect(row.state).toBe("withdrawn");
    expect(row.restored_at).not.toBeNull();
    // Final: a second withdraw is refused.
    expect((await adminPost(`/admin/dmca-notices/${t.noticeId}/withdraw`)).status).toBe(409);
  });

  it("409s a notice that was never taken down, and 404s an unknown id", async () => {
    const userId = await seedUser();
    const noticeId = await seedConfirmedNotice(await seedPost(userId));
    expect((await adminPost(`/admin/dmca-notices/${noticeId}/withdraw`)).status).toBe(409);
    expect((await adminPost(`/admin/dmca-notices/${crypto.randomUUID()}/withdraw`)).status).toBe(409);
  });
});

describe("GET /admin/dmca-notices: standing takedowns", () => {
  it("lists a takedown, then marks it waiting once the author has counter-noticed", async () => {
    const t = await takenDown();
    const list = async () => {
      const res = await call("/admin/dmca-notices", { headers: { "Cf-Access-Jwt-Assertion": await makeJwt() } });
      return ((await res.json()) as { counters: Array<{ id: string; state: string; restoreAfter: string | null }> }).counters.find((x) => x.id === t.noticeId);
    };
    expect((await list())?.state).toBe("taken_down");
    expect((await postCounter({ token: t.token, ...COUNTER })).status).toBe(200);
    const after = await list();
    expect(after?.state).toBe("counter_received");
    expect(after?.restoreAfter).not.toBeNull();
  });
});
