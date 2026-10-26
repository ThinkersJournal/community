// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { withClient } from "../src/db/client";
import { drainNoticeOutbox } from "../src/moderation/notice-outbox";

/**
 * A moderator's decisions on a confirmed DMCA notice (ROADMAP R9, PR 2):
 * `GET /admin/dmca-notices`, `POST /admin/dmca-notices/:id/takedown` and `/reject`.
 * The Access-JWT and Postmark stubs follow admin-dsa-notices.test.ts, which this
 * file's helpers are copied from (that file keeps them private).
 */

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
let createdNoticeIds: string[] = [];
let adminEmail: string;

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

async function adminGet(path: string): Promise<Response> {
  return call(path, { headers: { "Cf-Access-Jwt-Assertion": await makeJwt() } });
}

beforeEach(async () => {
  sentEmails = [];
  createdUserIds = [];
  createdNoticeIds = [];
  adminEmail = `mod-${crypto.randomUUID()}@example.test`;
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  __resetJwksCacheForTests();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.postmarkapp.com/email") {
      sentEmails.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
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
  await ctxRun(async (c) => {
    // Notices first (SET NULL keeps them past their target), then the queued emails, then users.
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

async function seedPost(userId: string): Promise<{ id: string; title: string }> {
  return ctxRun(async (c) => {
    const title = "test post " + crypto.randomUUID().slice(0, 8);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, $2, $3, 'test content', 'published', now()) RETURNING id`,
      [userId, title, "test-" + crypto.randomUUID().slice(0, 8)],
    );
    return { id: rows[0]!.id, title };
  });
}

async function seedNotice(postId: string, opts: { confirmed?: boolean; email?: string } = {}): Promise<{ id: string; email: string }> {
  const email = opts.email ?? `claimant-${crypto.randomUUID()}@example.test`;
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO dmca_notices
         (complainant_email, complainant_name, complainant_address, complainant_phone, signature, work_description,
          statement_good_faith, statement_accuracy, verify_token_hash, target_kind, target_label, post_id, email_verified_at)
       VALUES ($1, 'Jane Owner', '1 Example Street', '+1 555 0100', 'Jane Owner', 'My essay On Boats',
               true, true, $2, 'post', 'a label', $3, ${opts.confirmed === false ? "NULL" : "now()"})
       RETURNING id`,
      [email, `hash-${crypto.randomUUID()}`, postId],
    );
    return rows[0]!.id;
  });
  createdNoticeIds.push(id);
  return { id, email };
}

interface NoticeRow {
  state: string;
  decided_by: string | null;
  takedown_action_id: string | null;
  subject_user_id: string | null;
  counter_token_hash: string | null;
}
const noticeRow = (id: string) =>
  ctxRun(async (c) => {
    const { rows } = await c.query<NoticeRow>(
      `SELECT state, decided_by, takedown_action_id, subject_user_id, counter_token_hash FROM dmca_notices WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  });

const hiddenAt = (postId: string) =>
  ctxRun(async (c) => (await c.query<{ h: Date | null }>(`SELECT hidden_at AS h FROM posts WHERE id = $1`, [postId])).rows[0]!.h);

interface OutboxRow { kind: string; recipient_user_id: string | null; recipient_email: string | null; body_text: string; state: string }
const outboxFor = (actionId: string) =>
  ctxRun(async (c) => (await c.query<OutboxRow>(
    `SELECT kind, recipient_user_id, recipient_email, body_text, state FROM moderation_notice_outbox WHERE action_id = $1 ORDER BY kind`,
    [actionId],
  )).rows);

describe("GET /admin/dmca-notices", () => {
  it("lists a confirmed pending notice with its author's standing takedowns, and not an unconfirmed one", async () => {
    const author = await seedUser();
    const post = await seedPost(author);
    const confirmed = await seedNotice(post.id);
    const unconfirmed = await seedNotice(post.id, { confirmed: false });

    const res = await adminGet("/admin/dmca-notices");
    expect(res.status).toBe(200);
    const { notices } = (await res.json()) as { notices: Array<{ id: string; excerpt: string; authorStrikes: number; complainantName: string }> };
    const mine = notices.find((n) => n.id === confirmed.id);
    expect(mine).toBeDefined();
    expect(mine!.excerpt).toBe(post.title);
    expect(mine!.complainantName).toBe("Jane Owner");
    expect(mine!.authorStrikes).toBe(0);
    expect(notices.find((n) => n.id === unconfirmed.id)).toBeUndefined();
    // AC-1: listing (and a confirmed notice) hides nothing.
    expect(await hiddenAt(post.id)).toBeNull();
  });

  it("401s without an Access identity", async () => {
    expect((await call("/admin/dmca-notices")).status).toBe(401);
  });
});

describe("POST /admin/dmca-notices/:id/takedown", () => {
  it("hides the post, records a dmca_notice-sourced content_remove, moves the notice, and queues both emails", async () => {
    const author = await seedUser();
    const post = await seedPost(author);
    const notice = await seedNotice(post.id);

    const res = await adminPost(`/admin/dmca-notices/${notice.id}/takedown`);
    expect(res.status).toBe(200);
    const { actionId } = (await res.json()) as { actionId: string };

    expect(await hiddenAt(post.id)).not.toBeNull();
    const action = await ctxRun(async (c) =>
      (await c.query(
        `SELECT action, source, dmca_notice_id, dsa_notice_id, legal_ground, violation_category, actor_admin, subject_user_id
           FROM moderation_actions WHERE id = $1`,
        [actionId],
      )).rows[0],
    );
    expect(action).toEqual({
      action: "content_remove", source: "dmca_notice", dmca_notice_id: notice.id, dsa_notice_id: null,
      legal_ground: "copyright_infringement", violation_category: "ip_infringement", actor_admin: adminEmail,
      subject_user_id: author,
    });

    const row = await noticeRow(notice.id);
    expect(row.state).toBe("taken_down");
    expect(row.decided_by).toBe(adminEmail);
    expect(row.takedown_action_id).toBe(actionId);
    expect(row.subject_user_id).toBe(author);
    expect(row.counter_token_hash).toMatch(/^[0-9a-f]{64}$/);

    const outbox = await outboxFor(actionId);
    expect(outbox.map((o) => o.kind)).toEqual(["dmca_author_notice", "dmca_claimant_notice"]);
    const toAuthor = outbox[0]!;
    expect(toAuthor.recipient_user_id).toBe(author);
    expect(toAuthor.body_text).toContain("Jane Owner");
    expect(toAuthor.body_text).toContain("1 Example Street");
    expect(toAuthor.body_text).toContain("My essay On Boats");
    const link = /(https?:\/\/[^\s]*\/dmca\/counter\?token=[A-Za-z0-9_%~-]+)/.exec(toAuthor.body_text);
    expect(link, "no counter-notice link in the author's notice").not.toBeNull();
    // The raw token is mailed; only its hash is stored on the notice.
    expect(link![1]).not.toContain(row.counter_token_hash!);
    expect(outbox[1]!.recipient_email).toBe(notice.email);

    // After delivery the stored copy no longer holds a live counter-notice credential.
    const ctx = createExecutionContext();
    await drainNoticeOutbox(env, ctx, { onlyActionIds: [actionId] });
    await waitOnExecutionContext(ctx);
    const after = await outboxFor(actionId);
    expect(after.every((o) => o.state === "delivered")).toBe(true);
    expect(after[0]!.body_text).not.toMatch(/\/dmca\/counter\?token=/);
    expect(sentEmails.length).toBeGreaterThanOrEqual(2);
  });

  it("409s a second takedown and an unconfirmed notice, 404s an unknown id, and an unconfirmed notice hides nothing", async () => {
    const author = await seedUser();
    const post = await seedPost(author);
    const first = await seedNotice(post.id);
    expect((await adminPost(`/admin/dmca-notices/${first.id}/takedown`)).status).toBe(200);
    const again = await adminPost(`/admin/dmca-notices/${first.id}/takedown`);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("DMCA_NOT_PENDING");

    const post2 = await seedPost(author);
    const unconfirmed = await seedNotice(post2.id, { confirmed: false });
    const refused = await adminPost(`/admin/dmca-notices/${unconfirmed.id}/takedown`);
    expect(refused.status).toBe(409);
    expect(await hiddenAt(post2.id)).toBeNull();

    expect((await adminPost(`/admin/dmca-notices/${crypto.randomUUID()}/takedown`)).status).toBe(404);
    expect((await adminPost(`/admin/dmca-notices/not-a-uuid/takedown`)).status).toBe(404);
  });

  it("409 DMCA_TARGET_GONE when the author deleted the material; nothing is written", async () => {
    const author = await seedUser();
    const post = await seedPost(author);
    const notice = await seedNotice(post.id);
    await ctxRun((c) => c.query(`DELETE FROM posts WHERE id = $1`, [post.id]));

    const res = await adminPost(`/admin/dmca-notices/${notice.id}/takedown`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("DMCA_TARGET_GONE");
    expect((await noticeRow(notice.id)).state).toBe("pending");
  });

  it("still takes the material down for an anonymised author: no author notice, the claimant is told", async () => {
    const author = await seedUser();
    const post = await seedPost(author);
    const notice = await seedNotice(post.id);
    await ctxRun((c) => c.query(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [author]));

    const res = await adminPost(`/admin/dmca-notices/${notice.id}/takedown`);
    expect(res.status).toBe(200);
    const { actionId } = (await res.json()) as { actionId: string };
    expect(await hiddenAt(post.id)).not.toBeNull();
    expect((await outboxFor(actionId)).map((o) => o.kind)).toEqual(["dmca_claimant_notice"]);
  });

  it("counts the author's standing takedowns in the next notice's listing", async () => {
    const author = await seedUser();
    const a = await seedNotice((await seedPost(author)).id);
    expect((await adminPost(`/admin/dmca-notices/${a.id}/takedown`)).status).toBe(200);
    const b = await seedNotice((await seedPost(author)).id);
    const { notices } = (await (await adminGet("/admin/dmca-notices")).json()) as { notices: Array<{ id: string; authorStrikes: number }> };
    expect(notices.find((n) => n.id === b.id)!.authorStrikes).toBe(1);
  });
});

describe("POST /admin/dmca-notices/:id/reject", () => {
  it("rejects with a reason: the post stays up, the notice moves, the claimant is queued the reason", async () => {
    const author = await seedUser();
    const post = await seedPost(author);
    const notice = await seedNotice(post.id);

    const res = await adminPost(`/admin/dmca-notices/${notice.id}/reject`, { reason: "The work is in the public domain." });
    expect(res.status).toBe(204);

    expect(await hiddenAt(post.id)).toBeNull();
    const row = await noticeRow(notice.id);
    expect(row.state).toBe("rejected");
    expect(row.decided_by).toBe(adminEmail);
    const outbox = await outboxFor(notice.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.kind).toBe("dmca_claimant_notice");
    expect(outbox[0]!.recipient_email).toBe(notice.email);
    expect(outbox[0]!.body_text).toContain("The work is in the public domain.");
    // A rejection is not a ruling: no moderation_actions row was written for it.
    const actions = await ctxRun(async (c) => (await c.query(`SELECT 1 FROM moderation_actions WHERE dmca_notice_id = $1`, [notice.id])).rowCount);
    expect(actions).toBe(0);
  });

  it("400s a missing or blank reason, and 409s a notice that is already decided", async () => {
    const author = await seedUser();
    const post = await seedPost(author);
    const notice = await seedNotice(post.id);

    for (const body of [{}, { reason: "   " }, { reason: "x".repeat(2001) }]) {
      const res = await adminPost(`/admin/dmca-notices/${notice.id}/reject`, body);
      expect(res.status).toBe(400);
    }
    expect((await noticeRow(notice.id)).state).toBe("pending");

    expect((await adminPost(`/admin/dmca-notices/${notice.id}/reject`, { reason: "No." })).status).toBe(204);
    expect((await adminPost(`/admin/dmca-notices/${notice.id}/reject`, { reason: "No." })).status).toBe(409);
  });

  it("a notice whose material is gone can still be rejected", async () => {
    const author = await seedUser();
    const post = await seedPost(author);
    const notice = await seedNotice(post.id);
    await ctxRun((c) => c.query(`DELETE FROM posts WHERE id = $1`, [post.id]));
    expect((await adminPost(`/admin/dmca-notices/${notice.id}/reject`, { reason: "The material was already removed." })).status).toBe(204);
  });
});
