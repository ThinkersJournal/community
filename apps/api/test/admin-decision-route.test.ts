// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { withClient } from "../src/db/client";

import { applyDecision, type DecisionInput } from "../src/moderation/decide";
import { enqueueAuthorDecisionNotice } from "../src/moderation/notice-enqueue";
import { drainNoticeOutbox } from "../src/moderation/notice-outbox";
import { APPEAL_WINDOW_DAYS, DISPUTE_CONTACT_LINE, MODERATION_NOTICE_RETENTION_DAYS, NOTICE_UNDELIVERABLE_HORIZON_DAYS } from "@thinkersjournal/shared";

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

async function callCapturingPurges(path: string, init: RequestInit = {}): Promise<{ response: Response; purges: string[][] }> {
  const purges: string[][] = [];
  const web = {
    fetch: async (_url: string, initArg: RequestInit) => {
      purges.push((JSON.parse(initArg.body as string) as { tags: string[] }).tags);
      return new Response(JSON.stringify({ purged: 1 }), { status: 200 });
    },
  };
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://api.test${path}`, init), { ...env, WEB: web } as never, ctx);
  await waitOnExecutionContext(ctx);
  return { response, purges };
}

async function adminHeaders(): Promise<Record<string, string>> {
  return { "Cf-Access-Jwt-Assertion": await makeJwt() };
}

async function seedUser(): Promise<string> {
  const userId = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'x', now())
       RETURNING id`,
      [`test-${crypto.randomUUID()}@example.com`],
    );
    return rows[0]!.id;
  });
  createdUserIds.push(userId);
  return userId;
}

async function seedUserWithProfile(): Promise<{ userId: string; username: string }> {
  const created = await ctxRun(async (c) => {
    const username = `u${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'x', now())
       RETURNING id`,
      [`test-${crypto.randomUUID()}@example.com`],
    );
    const id = rows[0]!.id;
    await c.query(`INSERT INTO profiles (user_id, username) VALUES ($1, $2)`, [id, username]);
    return { id, username };
  });
  createdUserIds.push(created.id);
  return { userId: created.id, username: created.username };
}

async function seedPost(userId: string, hiddenAt?: Date): Promise<{ id: string; slug: string }> {
  return ctxRun(async (c) => {
    const slug = "test-" + crypto.randomUUID().slice(0, 8);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at, hidden_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [userId, "test", slug, "test content", "published", new Date(), hiddenAt ?? null],
    );
    return { id: rows[0]!.id, slug };
  });
}

async function seedComment(userId: string, postId: string, hiddenAt?: Date): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `WITH ids AS (SELECT uuidv7() AS id)
       INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown, hidden_at)
       SELECT ids.id, $1, $2, NULL, ids.id::text, 0, $3, $4
         FROM ids
       RETURNING id`,
      [postId, userId, "test comment", hiddenAt ?? null],
    );
    return rows[0]!.id;
  });
}

async function seedReport(postId: string): Promise<void> {
  const reporterId = await seedUser();
  await ctxRun(async (c) => {
    await c.query(`INSERT INTO reports (post_id, reporter_id, reason) VALUES ($1, $2, $3)`, [postId, reporterId, "spam"]);
  });
}

async function seedHiddenPost(): Promise<{ postId: string; hiddenAt: Date; authorEmail: string }> {
  const userId = await seedUser();
  const authorEmail = await ctxRun(async (c) => {
    const { rows } = await c.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0]!.email;
  });
  const hiddenAt = new Date();
  const post = await seedPost(userId, hiddenAt);
  await seedReport(post.id);
  return { postId: post.id, hiddenAt, authorEmail };
}

async function seedReportedButVisiblePost(): Promise<{ postId: string }> {
  const userId = await seedUser();
  const post = await seedPost(userId);
  await seedReport(post.id);
  return { postId: post.id };
}

async function seedHiddenComment(): Promise<{ commentId: string }> {
  const userId = await seedUser();
  const post = await seedPost(userId);
  const hiddenAt = new Date();
  const commentId = await seedComment(userId, post.id, hiddenAt);
  return { commentId };
}

async function hiddenAtOf(table: "posts" | "comments", id: string): Promise<Date | null> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ hidden_at: Date | null }>(
      `SELECT hidden_at FROM ${table} WHERE id = $1`,
      [id],
    );
    return rows[0]?.hidden_at ?? null;
  });
}

async function lastActionFor(subjectId: string): Promise<{ action: string; reason: string } | null> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM moderation_actions
       WHERE post_id = $1 OR comment_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [subjectId],
    );
    return rows[0] ?? null;
  });
}

async function actionCount(): Promise<number> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM moderation_actions WHERE actor_admin = $1`,
      [adminEmail],
    );
    return parseInt(rows[0]!.count, 10);
  });
}

async function decide(input: Partial<DecisionInput> & { subject: "post" | "comment"; subjectId: string; decision: "restore" | "keep_hidden" | "remove" }): Promise<Response> {
  return decideRaw({
    headers: {
      ...await adminHeaders(),
      Origin: ALLOWED_ORIGIN,
    },
    body: input,
  });
}

/**
 * POST /admin/decision and nothing else. Since notice outbox PR 1 the author's
 * notice is only QUEUED by the request; the two-minute cron drain sends it.
 */
async function postDecision(opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
  return call("/admin/decision", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

/**
 * `postDecision`, then ONE outbox drain scoped to this decision's action (the
 * test database is shared with other files, so an unscoped drain could send
 * their rows). This is what the cron does, so `sentEmails` keeps meaning "what
 * the author was mailed" for the tests that predate the outbox.
 */
async function decideRaw(opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
  const res = await postDecision(opts);
  if (res.status === 200) {
    const { actionId } = (await res.clone().json()) as { actionId: string };
    const ctx = createExecutionContext();
    await drainNoticeOutbox(env, ctx, { onlyActionIds: [actionId] });
    await waitOnExecutionContext(ctx);
  }
  return res;
}

/** A decision whose notice is left QUEUED: no drain runs. */
async function decideQueuedOnly(input: Partial<DecisionInput> & { subject: "post" | "comment"; subjectId: string; decision: "restore" | "keep_hidden" | "remove" }): Promise<Response> {
  return postDecision({ headers: { ...await adminHeaders(), Origin: ALLOWED_ORIGIN }, body: input });
}

interface OutboxRow {
  kind: string; state: string; attempts: number; recipient_user_id: string | null; recipient_email: string | null;
  subject: string; body_text: string; body_html: string; delivered_at: Date | null; last_error: string | null;
  retain_until: Date; next_attempt_at: Date;
}

/** The AUTHOR's row(s) for an action: the DSA reporters' rows (notice outbox PR 2) are read by `reporterRows`. */
async function outboxRows(actionId: string): Promise<OutboxRow[]> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<OutboxRow>(
      `SELECT kind, state, attempts, recipient_user_id, recipient_email, subject, body_text, body_html,
              delivered_at, last_error, retain_until, next_attempt_at
         FROM moderation_notice_outbox WHERE action_id = $1 AND kind <> 'reporter_outcome'`,
      [actionId],
    );
    return rows;
  });
}

async function reporterRows(actionId: string): Promise<Array<OutboxRow & { dsa_notice_id: string | null }>> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<OutboxRow & { dsa_notice_id: string | null }>(
      `SELECT kind, state, attempts, recipient_user_id, recipient_email, subject, body_text, body_html,
              delivered_at, last_error, retain_until, next_attempt_at, dsa_notice_id
         FROM moderation_notice_outbox WHERE action_id = $1 AND kind = 'reporter_outcome'`,
      [actionId],
    );
    return rows;
  });
}

async function appealTokenCount(actionId: string): Promise<number> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ n: string }>(`SELECT count(*) AS n FROM moderation_action_tokens WHERE action_id = $1`, [actionId]);
    return Number(rows[0]!.n);
  });
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
      // No FK from the outbox to users: remove its rows explicitly.
      await c.query(
        `DELETE FROM moderation_notice_outbox
          WHERE recipient_user_id = ANY($1::uuid[])
             OR action_id IN (SELECT id FROM moderation_actions WHERE subject_user_id = ANY($1::uuid[]))`,
        [createdUserIds],
      );
      await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]);
    });
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /admin/decision", () => {
  it("restore clears hidden_at and appends a content_restore action", async () => {
    const { postId } = await seedHiddenPost();
    const res = await decide({ subject: "post", subjectId: postId, decision: "restore", reason: "Report was mistaken." });
    expect(res.status).toBe(200);
    expect(await hiddenAtOf("posts", postId)).toBeNull();
    expect(await lastActionFor(postId)).toMatchObject({ action: "content_restore", reason: "Report was mistaken." });
  });

  it("keep_hidden PRESERVES an existing hidden_at rather than restamping it", async () => {
    // ⚠️ The original timestamp is evidence of WHEN the content was hidden.
    // A decision that restamps it destroys that, and the destruction is invisible.
    const { postId, hiddenAt } = await seedHiddenPost();
    await decide({ subject: "post", subjectId: postId, decision: "keep_hidden", reason: "Violates the guidelines." });
    expect(await hiddenAtOf("posts", postId)).toEqual(hiddenAt);
    expect(await lastActionFor(postId)).toMatchObject({ action: "content_keep_hidden" });
  });

  it("keep_hidden HIDES a reported item that was never auto-hidden", async () => {
    // Auto-hide is threshold-based, so an item can reach review un-hidden.
    // Without this, the queue's most common case has no reachable outcome.
    const { postId } = await seedReportedButVisiblePost();
    await decide({ subject: "post", subjectId: postId, decision: "keep_hidden", reason: "Violates the guidelines." });
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
  });

  it("remove hides permanently and appends content_remove", async () => {
    const { postId } = await seedReportedButVisiblePost();
    const res = await decide({ subject: "post", subjectId: postId, decision: "remove", reason: "Repeat infringement." });
    expect(res.status).toBe(200);
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
    expect(await lastActionFor(postId)).toMatchObject({ action: "content_remove" });
  });

  it("decides on a COMMENT as well as a post", async () => {
    const { commentId } = await seedHiddenComment();
    const res = await decide({ subject: "comment", subjectId: commentId, decision: "restore", reason: "Mistaken." });
    expect(res.status).toBe(200);
    expect(await hiddenAtOf("comments", commentId)).toBeNull();
  });

  // ⚠️ AC: the audit row and the state it describes can never disagree.
  it("writes NO action row when the subject does not exist", async () => {
    const before = await actionCount();
    const res = await decide({ subject: "post", subjectId: crypto.randomUUID(), decision: "remove", reason: "x" });
    expect(res.status).toBe(404);
    expect(await actionCount()).toBe(before);
  });

  it("401s without a Cloudflare Access assertion", async () => {
    const res = await decideRaw({ headers: { Origin: ALLOWED_ORIGIN } });
    expect(res.status).toBe(401);
  });

  // ⚠️ THE CSRF CASE. Access proves WHO, not that the request was INTENDED:
  // Cloudflare injects the assertion from the CF_Authorization cookie, so a
  // cross-site form post from a logged-in moderator's browser carries a VALID
  // one. Without the inline checkOrigin this returns 200 and removes content.
  it("403s a VALID admin assertion sent from a foreign origin", async () => {
    const { postId } = await seedHiddenPost();
    const res = await decideRaw({
      headers: { ...await adminHeaders(), Origin: "https://evil.test" },
      body: { subject: "post", subjectId: postId, decision: "remove", reason: "x" },
    });
    expect(res.status).toBe(403);
    // and it must not have acted
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
    expect(await lastActionFor(postId)).toBeNull();
  });

  it("400s an unknown decision value", async () => {
    const { postId } = await seedHiddenPost();
    const res = await decide({ subject: "post", subjectId: postId, decision: "banish" as never, reason: "x" });
    expect(res.status).toBe(400);
  });

  it("400s an empty reason — the statement of reasons is not optional", async () => {
    const { postId } = await seedHiddenPost();
    const res = await decide({ subject: "post", subjectId: postId, decision: "remove", reason: "   " });
    expect(res.status).toBe(400);
  });

  // CONTROL: without this, every 4xx above is indistinguishable from
  // "this harness cannot reach the route at all".
  it("CONTROL: a well-formed decision from an admin succeeds", async () => {
    const { postId } = await seedHiddenPost();
    expect((await decide({ subject: "post", subjectId: postId, decision: "restore", reason: "ok" })).status).toBe(200);
  });

  it("400s a request whose body is the literal JSON null", async () => {
    const res = await call("/admin/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...await adminHeaders(),
        Origin: ALLOWED_ORIGIN,
      },
      body: "null",
    });
    expect(res.status).toBe(400);
  });

  it("400s a well-formed decision whose subjectId is not a UUID", async () => {
    const { postId } = await seedHiddenPost();
    const before = await actionCount();
    const res = await decideRaw({
      headers: { ...await adminHeaders(), Origin: ALLOWED_ORIGIN },
      body: { subject: "post", subjectId: "not-a-uuid", decision: "remove", reason: "x" },
    });
    expect(res.status).toBe(400);
    expect(await actionCount()).toBe(before);
  });

  it("a decision emails the AUTHOR once, on the outbound stream, with the reason", async () => {
    const { postId, authorEmail } = await seedHiddenPost();
    await decide({
      subject: "post",
      subjectId: postId,
      decision: "remove",
      reason: "Repeat infringement.",
    });
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({ To: authorEmail, MessageStream: "outbound" });
    expect(String(sentEmails[0]!["TextBody"])).toContain("Repeat infringement.");
  });

  it("a decision on a missing subject sends NO email", async () => {
    await decide({
      subject: "post",
      subjectId: crypto.randomUUID(),
      decision: "remove",
      reason: "x",
    });
    expect(sentEmails).toHaveLength(0);
  });

  describe("#113 plan B — the appeal link", () => {
    async function appealTokenRowsFor(userId: string): Promise<Array<{ purpose: string; user_id: string; action_id: string }>> {
      return ctxRun(async (c) => {
        const { rows } = await c.query<{ purpose: string; user_id: string; action_id: string }>(
          `SELECT purpose, user_id, action_id FROM moderation_action_tokens WHERE user_id = $1`,
          [userId],
        );
        return rows;
      });
    }

    it("a remove decision emails the appeal link, and exactly one appeal token row exists, tied to the author and the action", async () => {
      const { postId, authorEmail } = await seedHiddenPost();
      const res = await decide({ subject: "post", subjectId: postId, decision: "remove", reason: "x" });
      const { actionId } = (await res.json()) as { actionId: string };

      expect(sentEmails).toHaveLength(1);
      expect(String(sentEmails[0]!["TextBody"])).toContain("/appeal?token=");

      // The author's id is not returned to the test directly, so look it up
      // the same way the decision did: from the post's own row.
      const authorId = await ctxRun(async (c) => {
        const { rows } = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [authorEmail]);
        return rows[0]!.id;
      });

      const rows = await appealTokenRowsFor(authorId);
      // ⚠️ Without this, a token minted for the WRONG account would pass a
      // bare row-count assertion.
      expect(rows).toEqual([{ purpose: "appeal", user_id: authorId, action_id: actionId }]);
    });

    it("a restore of hidden content mints NO token", async () => {
      const { postId, authorEmail } = await seedHiddenPost();
      const res = await decide({ subject: "post", subjectId: postId, decision: "restore", reason: "Mistaken." });
      // CONTROL: the restore itself succeeded and sent its own notice — without
      // this, "no token row" would be indistinguishable from "the decision
      // never ran at all".
      expect(res.status).toBe(200);
      expect(sentEmails).toHaveLength(1);

      const authorId = await ctxRun(async (c) => {
        const { rows } = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [authorEmail]);
        return rows[0]!.id;
      });
      expect(await appealTokenRowsFor(authorId)).toEqual([]);
    });

    // ⚠️ SINCE NOTICE OUTBOX PR 1 THE MINT IS INSIDE THE DECISION'S TRANSACTION,
    // so a mint failure ROLLS THE DECISION BACK (design section 4: an
    // unannounceable decision is the failure being closed). Forces a real
    // INSERT failure with a trigger scoped to ONE author, since this codebase
    // has no module-mocking precedent against the workerd pool.
    it("a mint that throws rolls the whole decision back (no action row, still visible, no outbox row); an unrelated author is unaffected", async () => {
      const userId = await seedUser();
      const post = await seedPost(userId);
      const otherUserId = await seedUser();
      const otherPost = await seedPost(otherUserId);

      const suffix = crypto.randomUUID().replace(/-/g, "");
      const fnName = `test_fail_on_token_insert_${suffix}`;
      const trgName = `test_fail_token_insert_${suffix}`;
      await ctxRun(async (c) => {
        await c.query(
          `CREATE FUNCTION ${fnName}() RETURNS trigger AS $$
           BEGIN
             RAISE EXCEPTION 'forced mint failure';
           END;
           $$ LANGUAGE plpgsql`,
        );
        await c.query(
          `CREATE TRIGGER ${trgName}
             BEFORE INSERT ON moderation_action_tokens
             FOR EACH ROW
             WHEN (NEW.user_id = '${userId}'::uuid)
             EXECUTE FUNCTION ${fnName}()`,
        );
      });

      try {
        const input = { subject: "post", decision: "remove", reason: "x", actorAdmin: adminEmail, enqueueNotice: { origin: "https://community.thinkersjournal.com" } } as const;
        await expect(ctxRun((c) => applyDecision(c, { ...input, subjectId: post.id }))).rejects.toThrow(/forced mint failure/);

        const after = await ctxRun(async (c) => {
          const hidden = await c.query<{ hidden_at: Date | null }>(`SELECT hidden_at FROM posts WHERE id = $1`, [post.id]);
          const actions = await c.query(`SELECT 1 FROM moderation_actions WHERE post_id = $1`, [post.id]);
          const outbox = await c.query(`SELECT 1 FROM moderation_notice_outbox WHERE recipient_user_id = $1`, [userId]);
          return { hiddenAt: hidden.rows[0]!.hidden_at, actions: actions.rowCount, outbox: outbox.rowCount };
        });
        expect(after).toEqual({ hiddenAt: null, actions: 0, outbox: 0 });

        // CONTROL: the same call for an author the trigger does not match
        // succeeds and queues its notice, so the failure above is the trigger.
        const ok = await ctxRun((c) => applyDecision(c, { ...input, subjectId: otherPost.id }));
        expect(ok).not.toBeNull();
        expect(await outboxRows(ok!.actionId)).toHaveLength(1);
      } finally {
        await ctxRun(async (c) => {
          await c.query(`DROP TRIGGER IF EXISTS ${trgName} ON moderation_action_tokens`);
          await c.query(`DROP FUNCTION IF EXISTS ${fnName}()`);
        });
      }
    });

    it("an outbox INSERT that fails rolls the decision back too, and takes the minted appeal token with it", async () => {
      const userId = await seedUser();
      const post = await seedPost(userId);
      const suffix = crypto.randomUUID().replace(/-/g, "");
      const fnName = `test_fail_on_outbox_insert_${suffix}`;
      const trgName = `test_fail_outbox_insert_${suffix}`;
      await ctxRun(async (c) => {
        await c.query(
          `CREATE FUNCTION ${fnName}() RETURNS trigger AS $$
           BEGIN
             RAISE EXCEPTION 'forced outbox failure';
           END;
           $$ LANGUAGE plpgsql`,
        );
        await c.query(
          `CREATE TRIGGER ${trgName}
             BEFORE INSERT ON moderation_notice_outbox
             FOR EACH ROW
             WHEN (NEW.recipient_user_id = '${userId}'::uuid)
             EXECUTE FUNCTION ${fnName}()`,
        );
      });
      try {
        await expect(
          ctxRun((c) =>
            applyDecision(c, {
              subject: "post", subjectId: post.id, decision: "remove", reason: "x", actorAdmin: adminEmail,
              enqueueNotice: { origin: "https://community.thinkersjournal.com" },
            }),
          ),
        ).rejects.toThrow(/forced outbox failure/);
        const after = await ctxRun(async (c) => {
          const hidden = await c.query<{ hidden_at: Date | null }>(`SELECT hidden_at FROM posts WHERE id = $1`, [post.id]);
          const actions = await c.query(`SELECT 1 FROM moderation_actions WHERE post_id = $1`, [post.id]);
          const tokens = await c.query(`SELECT 1 FROM moderation_action_tokens WHERE user_id = $1`, [userId]);
          return { hiddenAt: hidden.rows[0]!.hidden_at, actions: actions.rowCount, tokens: tokens.rowCount };
        });
        expect(after).toEqual({ hiddenAt: null, actions: 0, tokens: 0 });
      } finally {
        await ctxRun(async (c) => {
          await c.query(`DROP TRIGGER IF EXISTS ${trgName} ON moderation_notice_outbox`);
          await c.query(`DROP FUNCTION IF EXISTS ${fnName}()`);
        });
      }
    });
  });

  it("a cross-origin decision sends NO email", async () => {
    const { postId } = await seedHiddenPost();
    await decideRaw({
      headers: { ...await adminHeaders(), Origin: "https://evil.test" },
      body: { subject: "post", subjectId: postId, decision: "remove", reason: "x" },
    });
    expect(sentEmails).toHaveLength(0);
  });

  it("Remove on a tagged post purges exactly post:<id>, author:<authorId>, listing, tag:<slug>", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId);
    // Attach a tag
    const tagSlug = `t-${crypto.randomUUID().slice(0, 8)}`;
    await ctxRun(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO tags (slug, label) VALUES ($1::citext, $1) RETURNING id`,
        [tagSlug],
      );
      const tagId = rows[0]!.id;
      await c.query(`INSERT INTO post_tags (post_id, tag_id) VALUES ($1, $2)`, [post.id, tagId]);
    });

    try {
      await seedReport(post.id);

      const { response, purges } = await callCapturingPurges("/admin/decision", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...await adminHeaders(),
          Origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({
          subject: "post",
          subjectId: post.id,
          decision: "remove",
          reason: "Spam.",
        }),
      });

      expect(response.status).toBe(200);
      expect(purges).toHaveLength(1);
      // Exactly these four. Dropping the author tag would leave the author's
      // profile page serving the removed post, and toContain could not see it.
      expect([...purges[0]!].sort()).toEqual(
        [`post:${post.id}`, `author:${userId}`, "listing", `tag:${tagSlug}`].sort(),
      );
    } finally {
      await ctxRun(async (c) => {
        await c.query(`DELETE FROM tags WHERE slug = $1`, [tagSlug]);
      });
    }
  });

  it("A decision on a comment purges exactly post:<post_id>", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId);
    const commentId = await seedComment(userId, post.id);

    const { response, purges } = await callCapturingPurges("/admin/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...await adminHeaders(),
        Origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({
        subject: "comment",
        subjectId: commentId,
        decision: "remove",
        reason: "Spam.",
      }),
    });

    expect(response.status).toBe(200);
    expect(purges).toHaveLength(1);
    expect(purges[0]).toEqual([`post:${post.id}`]);
  });

  it("A 404 (missing subject) purges nothing", async () => {
    const { response, purges } = await callCapturingPurges("/admin/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...await adminHeaders(),
        Origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({
        subject: "post",
        subjectId: crypto.randomUUID(),
        decision: "remove",
        reason: "x",
      }),
    });

    expect(response.status).toBe(404);
    expect(purges).toHaveLength(0);
  });

  it("A cross-origin decision purges nothing", async () => {
    const { postId } = await seedHiddenPost();
    const { response, purges } = await callCapturingPurges("/admin/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...await adminHeaders(),
        Origin: "https://evil.test",
      },
      body: JSON.stringify({
        subject: "post",
        subjectId: postId,
        decision: "remove",
        reason: "x",
      }),
    });

    expect(response.status).toBe(403);
    expect(purges).toHaveLength(0);
  });

  it("Restore of a hidden post becomes visible in public read", async () => {
    const { userId, username } = await seedUserWithProfile();
    const post = await seedPost(userId, new Date());
    await seedReport(post.id);

    // Before restore: should 404
    let res = await call(`/public/posts?username=${username}&slug=${post.slug}`);
    expect(res.status).toBe(404);

    // Apply restore
    await decide({
      subject: "post",
      subjectId: post.id,
      decision: "restore",
      reason: "Mistaken.",
    });

    // After restore: should be 200
    res = await call(`/public/posts?username=${username}&slug=${post.slug}`);
    expect(res.status).toBe(200);
  });

  it("Remove of a visible post becomes inaccessible in public read", async () => {
    const { userId, username } = await seedUserWithProfile();
    const post = await seedPost(userId);
    await seedReport(post.id);

    // Before remove: should be 200
    let res = await call(`/public/posts?username=${username}&slug=${post.slug}`);
    expect(res.status).toBe(200);

    // Apply remove
    await decide({
      subject: "post",
      subjectId: post.id,
      decision: "remove",
      reason: "Repeat infringement.",
    });

    // After remove: should 404
    res = await call(`/public/posts?username=${username}&slug=${post.slug}`);
    expect(res.status).toBe(404);
  });

  it("Restore of a never-hidden post sends NO email", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId);
    await seedReport(post.id);

    sentEmails = [];
    await decide({
      subject: "post",
      subjectId: post.id,
      decision: "restore",
      reason: "Mistaken.",
    });
    expect(sentEmails).toHaveLength(0);
  });

  it("Restore of a HIDDEN post emails 'has been restored'", async () => {
    const { postId, authorEmail } = await seedHiddenPost();

    sentEmails = [];
    await decide({ subject: "post", subjectId: postId, decision: "restore", reason: "Reviewed; no violation." });

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({ To: authorEmail, Subject: "Your content has been restored" });
  });

  it("Keep hidden of a never-hidden COMMENT sends 'has been hidden' and names the parent post", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId);
    const commentId = await seedComment(userId, post.id);

    sentEmails = [];
    await decide({ subject: "comment", subjectId: commentId, decision: "keep_hidden", reason: "Harassment." });

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({ Subject: "Your content has been hidden after review" });
    // seedPost titles every post "test".
    expect(String(sentEmails[0]!["TextBody"])).toContain('This is about your comment on "test".');
  });

  it("Keep hidden of a never-hidden post sends the 'has been hidden' subject", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId);
    await seedReport(post.id);

    sentEmails = [];
    await decide({
      subject: "post",
      subjectId: post.id,
      decision: "keep_hidden",
      reason: "Violates the guidelines.",
    });
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({ Subject: "Your content has been hidden after review" });
  });

  it("a failed notice send does not undo the decision: the notice stays queued for retry (attempts 1, http_500, next attempt in the future)", async () => {
    const { postId, authorEmail } = await seedHiddenPost();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let postmarkCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://api.postmarkapp.com/email") {
        postmarkCalls++;
        return new Response("Internal Server Error", { status: 500 });
      }
      const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }));

    const res = await decide({ subject: "post", subjectId: postId, decision: "remove", reason: "x" });

    expect(res.status).toBe(200);
    const { actionId } = (await res.json()) as { actionId: string };
    expect(postmarkCalls).toBe(1);
    const rows = await outboxRows(actionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "pending", attempts: 1, last_error: "http_500", delivered_at: null });
    expect(rows[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    // No log line carries the author's address.
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(authorEmail);
  });
});

/** A random 64-hex-char sha256 — the shape mediaKey()/r2KeyForSha256() expect. */
function randomSha(): string {
  return crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
}

function keyFor(sha: string): string {
  return `media/post/${sha}.webp`;
}

function markdownWith(sha: string): string {
  return `![img](https://cdn.thinkersjournal.com/${keyFor(sha)})`;
}

describe("POST /admin/decision — #61 media visibility", () => {
  it("hiding a post with unshared media moves the object to the restricted bucket", async () => {
    const userId = await seedUser();
    const sha = randomSha();
    const post = await ctxRun(async (c) => {
      const slug = "test-" + crypto.randomUUID().slice(0, 8);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
         VALUES ($1, 'test', $2, $3, 'published', now()) RETURNING id`,
        [userId, slug, markdownWith(sha)],
      );
      return rows[0]!.id;
    });
    await seedReport(post);
    await env.MEDIA.put(keyFor(sha), "bytes");

    const res = await decide({ subject: "post", subjectId: post, decision: "keep_hidden", reason: "x" });
    expect(res.status).toBe(200);

    expect(await env.MEDIA.head(keyFor(sha))).toBeNull();
    expect(await env.MEDIA_RESTRICTED.head(keyFor(sha))).not.toBeNull();
  });

  it("hiding a post whose media is ALSO referenced by another visible post leaves it public (dedup)", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const sha = randomSha();
    const hiddenPost = await ctxRun(async (c) => {
      const slug = "test-" + crypto.randomUUID().slice(0, 8);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
         VALUES ($1, 'test', $2, $3, 'published', now()) RETURNING id`,
        [userId, slug, markdownWith(sha)],
      );
      return rows[0]!.id;
    });
    // A second, VISIBLE post shares the identical content-addressed key.
    await ctxRun(async (c) => {
      const slug = "test-" + crypto.randomUUID().slice(0, 8);
      await c.query(
        `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
         VALUES ($1, 'test', $2, $3, 'published', now())`,
        [otherUserId, slug, markdownWith(sha)],
      );
    });
    await seedReport(hiddenPost);
    await env.MEDIA.put(keyFor(sha), "bytes");

    const res = await decide({ subject: "post", subjectId: hiddenPost, decision: "keep_hidden", reason: "x" });
    expect(res.status).toBe(200);

    expect(await env.MEDIA.head(keyFor(sha))).not.toBeNull();
    expect(await env.MEDIA_RESTRICTED.head(keyFor(sha))).toBeNull();
  });

  it("a legal hold restricts the key UNCONDITIONALLY, even when another visible post shares it", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const sha = randomSha();
    const hiddenPost = await ctxRun(async (c) => {
      const slug = "test-" + crypto.randomUUID().slice(0, 8);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
         VALUES ($1, 'test', $2, $3, 'published', now()) RETURNING id`,
        [userId, slug, markdownWith(sha)],
      );
      return rows[0]!.id;
    });
    await ctxRun(async (c) => {
      const slug = "test-" + crypto.randomUUID().slice(0, 8);
      await c.query(
        `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
         VALUES ($1, 'test', $2, $3, 'published', now())`,
        [otherUserId, slug, markdownWith(sha)],
      );
    });
    await seedReport(hiddenPost);
    await env.MEDIA.put(keyFor(sha), "bytes");

    // `legalHold`/`legalHoldCategory` aren't on `DecisionInput` (they're
    // admin.ts's own body fields, not part of the decide.ts transaction) —
    // `decide()` forwards whatever it's given as the JSON body regardless.
    const legalRes = await decide({
      subject: "post",
      subjectId: hiddenPost,
      decision: "remove",
      reason: "CSAM report",
      legalHold: true,
      legalHoldCategory: "csam",
    } as unknown as Partial<DecisionInput> & { subject: "post"; subjectId: string; decision: "remove" });
    expect(legalRes.status).toBe(200);

    expect(await env.MEDIA.head(keyFor(sha))).toBeNull();
    expect(await env.MEDIA_RESTRICTED.head(keyFor(sha))).not.toBeNull();

    // Restoring the post must NOT lift the hold.
    const restoreRes = await decide({ subject: "post", subjectId: hiddenPost, decision: "restore", reason: "x" });
    expect(restoreRes.status).toBe(200);
    expect(await env.MEDIA.head(keyFor(sha))).toBeNull();
    expect(await env.MEDIA_RESTRICTED.head(keyFor(sha))).not.toBeNull();
  });

  it("legalHold is rejected on a restore decision", async () => {
    const { postId } = await seedHiddenPost();
    const res = await decide({
      subject: "post",
      subjectId: postId,
      decision: "restore",
      reason: "x",
      legalHold: true,
      legalHoldCategory: "csam",
    } as unknown as Partial<DecisionInput> & { subject: "post"; subjectId: string; decision: "restore" });
    expect(res.status).toBe(400);
  });

  it("restoring an ordinarily-hidden (non-legal) post moves its media back to public", async () => {
    const userId = await seedUser();
    const sha = randomSha();
    const post = await ctxRun(async (c) => {
      const slug = "test-" + crypto.randomUUID().slice(0, 8);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
         VALUES ($1, 'test', $2, $3, 'published', now()) RETURNING id`,
        [userId, slug, markdownWith(sha)],
      );
      return rows[0]!.id;
    });
    await seedReport(post);
    await env.MEDIA.put(keyFor(sha), "bytes");
    await decide({ subject: "post", subjectId: post, decision: "keep_hidden", reason: "x" });
    expect(await env.MEDIA_RESTRICTED.head(keyFor(sha))).not.toBeNull();

    const res = await decide({ subject: "post", subjectId: post, decision: "restore", reason: "x" });
    expect(res.status).toBe(200);
    expect(await env.MEDIA.head(keyFor(sha))).not.toBeNull();
  });
});

describe("POST /admin/decision — T1 account legal hold", () => {
  async function activeHoldFor(userId: string): Promise<{ category: string; moderation_action_id: string | null } | null> {
    return ctxRun(async (c) => {
      const { rows } = await c.query<{ category: string; moderation_action_id: string | null }>(
        `SELECT category, moderation_action_id FROM account_legal_holds
          WHERE user_id = $1 AND released_at IS NULL`,
        [userId],
      );
      return rows[0] ?? null;
    });
  }

  async function lastActionId(subjectId: string): Promise<string> {
    return ctxRun(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM moderation_actions
          WHERE post_id = $1 OR comment_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [subjectId],
      );
      return rows[0]!.id;
    });
  }

  it("remove with legalHold: true, legalHoldCategory: dmca holds the author's account, tied to the decision's action", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId);
    const res = await decide({
      subject: "post",
      subjectId: post.id,
      decision: "remove",
      reason: "x",
      legalHold: true,
      legalHoldCategory: "dmca",
    } as unknown as Partial<DecisionInput> & { subject: "post"; subjectId: string; decision: "remove" });
    expect(res.status).toBe(200);

    const actionId = await lastActionId(post.id);
    const hold = await activeHoldFor(userId);
    expect(hold).not.toBeNull();
    expect(hold?.category).toBe("dmca");
    expect(hold?.moderation_action_id).toBe(actionId);
  });

  it("a decision without a legal hold leaves the author with no account hold", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId);
    const res = await decide({ subject: "post", subjectId: post.id, decision: "remove", reason: "x" });
    expect(res.status).toBe(200);

    const hold = await activeHoldFor(userId);
    expect(hold).toBeNull();
  });

  it("AH-3: a commit-time failure after the account-hold insert leaves neither the decision nor the hold", async () => {
    const authorId = await seedUser();
    const post = await seedPost(authorId);
    // Unique names: the test DB is shared across files, and the WHEN clause
    // scopes the trigger to THIS author, so no other file's holds are affected.
    const suffix = crypto.randomUUID().replace(/-/g, "");
    const fnName = `test_fail_on_account_hold_${suffix}`;
    const trgName = `test_fail_account_hold_${suffix}`;
    await ctxRun(async (c) => {
      await c.query(
        `CREATE FUNCTION ${fnName}() RETURNS trigger AS $$
         BEGIN
           RAISE EXCEPTION 'forced failure after account hold';
         END;
         $$ LANGUAGE plpgsql`,
      );
      // DEFERRED: fires at COMMIT, strictly after decide.ts's hold INSERT (and
      // every other write) has run in the still-open transaction.
      await c.query(
        `CREATE CONSTRAINT TRIGGER ${trgName}
           AFTER INSERT ON account_legal_holds
           DEFERRABLE INITIALLY DEFERRED
           FOR EACH ROW
           WHEN (NEW.user_id = '${authorId}'::uuid)
           EXECUTE FUNCTION ${fnName}()`,
      );
    });
    try {
      await expect(
        ctxRun((c) =>
          applyDecision(c, {
            subject: "post",
            subjectId: post.id,
            decision: "remove",
            reason: "x",
            actorAdmin: adminEmail,
            accountHold: { category: "dmca" },
          }),
        ),
      ).rejects.toThrow(/forced failure after account hold/);

      const after = await ctxRun(async (c) => {
        const hidden = await c.query<{ hidden_at: Date | null }>(`SELECT hidden_at FROM posts WHERE id = $1`, [post.id]);
        const actions = await c.query(`SELECT 1 FROM moderation_actions WHERE post_id = $1`, [post.id]);
        const holds = await c.query(`SELECT 1 FROM account_legal_holds WHERE user_id = $1`, [authorId]);
        return { hiddenAt: hidden.rows[0]!.hidden_at, actions: actions.rowCount, holds: holds.rowCount };
      });
      expect(after).toEqual({ hiddenAt: null, actions: 0, holds: 0 });
    } finally {
      await ctxRun(async (c) => {
        await c.query(`DROP TRIGGER IF EXISTS ${trgName} ON account_legal_holds`);
        await c.query(`DROP FUNCTION IF EXISTS ${fnName}()`);
      });
    }
  });

  it("control: the same deferred-failure setup scoped to an unrelated author succeeds and leaves a hold", async () => {
    const authorId = await seedUser();
    const post = await seedPost(authorId);
    const unrelatedId = crypto.randomUUID();
    const suffix = crypto.randomUUID().replace(/-/g, "");
    const fnName = `test_fail_on_account_hold_${suffix}`;
    const trgName = `test_fail_account_hold_${suffix}`;
    await ctxRun(async (c) => {
      await c.query(
        `CREATE FUNCTION ${fnName}() RETURNS trigger AS $$
         BEGIN
           RAISE EXCEPTION 'forced failure after account hold';
         END;
         $$ LANGUAGE plpgsql`,
      );
      await c.query(
        `CREATE CONSTRAINT TRIGGER ${trgName}
           AFTER INSERT ON account_legal_holds
           DEFERRABLE INITIALLY DEFERRED
           FOR EACH ROW
           WHEN (NEW.user_id = '${unrelatedId}'::uuid)
           EXECUTE FUNCTION ${fnName}()`,
      );
    });
    try {
      const result = await ctxRun((c) =>
        applyDecision(c, {
          subject: "post",
          subjectId: post.id,
          decision: "remove",
          reason: "x",
          actorAdmin: adminEmail,
          accountHold: { category: "dmca" },
        }),
      );
      expect(result).not.toBeNull();
      const hold = await activeHoldFor(authorId);
      expect(hold).not.toBeNull();
      expect(hold?.category).toBe("dmca");
    } finally {
      await ctxRun(async (c) => {
        await c.query(`DROP TRIGGER IF EXISTS ${trgName} ON account_legal_holds`);
        await c.query(`DROP FUNCTION IF EXISTS ${fnName}()`);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The author notice is sent when, and only when, there is an author who can
// receive it (#138 anonymised author, #135 tombstoned comment). Everything
// ELSE a decision does is unchanged — that is half of what these pin.
// ---------------------------------------------------------------------------
describe("POST /admin/decision author-notice gate (#138, #135)", () => {
  async function seedAnonymisedUser(): Promise<{ userId: string; email: string }> {
    const userId = await seedUser();
    const email = `deleted-${userId}@invalid.thinkersjournal.local`;
    await ctxRun(async (c) => {
      await c.query(`UPDATE users SET email = $2, anonymised_at = now() WHERE id = $1`, [userId, email]);
    });
    return { userId, email };
  }

  async function seedTombstone(userId: string, postId: string): Promise<string> {
    return ctxRun(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `WITH ids AS (SELECT uuidv7() AS id)
         INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown, deleted_at)
         SELECT ids.id, $1, $2, NULL, ids.id::text, 0, '', now() FROM ids
         RETURNING id`,
        [postId, userId],
      );
      return rows[0]!.id;
    });
  }

  async function seedConfirmedPostNotice(postId: string, reporterEmail: string): Promise<void> {
    await ctxRun(async (c) => {
      await c.query(
        `INSERT INTO dsa_notices
           (reporter_email, reporter_name, good_faith, verify_token_hash, target_kind, target_label, post_id, reason, statement, email_verified_at)
         VALUES ($1, 'A Reporter', true, $2, 'post', 'a post', $3, 'spam', 'This violates the rules.', now())`,
        [reporterEmail, `hash-${crypto.randomUUID()}`, postId],
      );
    });
  }

  async function tokenCount(actionId: string): Promise<number> {
    return ctxRun(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM moderation_action_tokens WHERE action_id = $1`,
        [actionId],
      );
      return Number(rows[0]!.n);
    });
  }

  async function authorEmailOf(userId: string): Promise<string> {
    return ctxRun(async (c) => {
      const { rows } = await c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
      return rows[0]!.email;
    });
  }

  async function removeAndRead(subject: "post" | "comment", subjectId: string): Promise<{ status: number; actionId: string }> {
    const res = await decide({ subject, subjectId, decision: "remove", reason: "Confirmed violation." });
    const body = res.status === 200 ? ((await res.json()) as { actionId: string }) : { actionId: "" };
    return { status: res.status, actionId: body.actionId };
  }

  // CHARACTERISATION: written first and green on main before any change.
  it("a live author still gets exactly one notice, with an appeal link, and the token is minted", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId);
    await seedConfirmedPostNotice(post.id, "reporter@example.test");

    sentEmails = [];
    const { status, actionId } = await removeAndRead("post", post.id);
    expect(status).toBe(200);

    const toAuthor = sentEmails.filter((e) => e["To"] !== "reporter@example.test");
    expect(toAuthor).toHaveLength(1);
    expect(toAuthor[0]!["To"]).toBe(await authorEmailOf(userId));
    expect(String(toAuthor[0]!["TextBody"])).toContain("/appeal?token=");
    expect(await tokenCount(actionId)).toBe(1);
    // ...and it went through the outbox: exactly one queued row (sent by the drain this helper ran).
    expect(await outboxRows(actionId)).toHaveLength(1);
    // ...and the DSA reporter is told too.
    expect(sentEmails.filter((e) => e["To"] === "reporter@example.test")).toHaveLength(1);
  });

  it("an anonymised author: 200, the action is recorded and the content hidden, NO author send, the DSA reporter is still told", async () => {
    const { userId, email } = await seedAnonymisedUser();
    const post = await seedPost(userId);
    await seedConfirmedPostNotice(post.id, "reporter@example.test");

    sentEmails = [];
    const { status, actionId } = await removeAndRead("post", post.id);
    expect(status).toBe(200);

    expect(await lastActionFor(post.id)).toMatchObject({ action: "content_remove" });
    expect(await hiddenAtOf("posts", post.id)).not.toBeNull();
    expect(sentEmails.filter((e) => e["To"] === email)).toHaveLength(0);
    expect(sentEmails.filter((e) => String(e["To"]).endsWith("@invalid.thinkersjournal.local"))).toHaveLength(0);
    expect(await tokenCount(actionId)).toBe(0);
    expect(await outboxRows(actionId)).toHaveLength(0);
    // The reporter is owed an outcome whatever happened to the author's account (Art. 16(5)).
    expect(sentEmails.filter((e) => e["To"] === "reporter@example.test")).toHaveLength(1);
    expect(sentEmails).toHaveLength(1);
  });

  it("an anonymised author's comment: same", async () => {
    const { userId, email } = await seedAnonymisedUser();
    const post = await seedPost(userId);
    const commentId = await seedComment(userId, post.id);

    sentEmails = [];
    const { status } = await removeAndRead("comment", commentId);
    expect(status).toBe(200);
    expect(await lastActionFor(commentId)).toMatchObject({ action: "content_remove" });
    expect(sentEmails.filter((e) => e["To"] === email)).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
  });

  it("a tombstoned comment by a LIVE author: 200, action recorded, NO author send and NO appeal token minted", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId);
    const commentId = await seedTombstone(userId, post.id);

    sentEmails = [];
    const { status, actionId } = await removeAndRead("comment", commentId);
    expect(status).toBe(200);
    expect(await lastActionFor(commentId)).toMatchObject({ action: "content_remove" });
    expect(sentEmails).toHaveLength(0);
    // The live author means the mint WOULD have succeeded: this is what proves
    // the mint is gated, not just the send.
    expect(await tokenCount(actionId)).toBe(0);
    expect(await outboxRows(actionId)).toHaveLength(0);
  });

  it("a skipped notice logs one structured line with the action id and the reason, and no address", async () => {
    const { userId, email } = await seedAnonymisedUser();
    const post = await seedPost(userId);
    const info = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { actionId } = await removeAndRead("post", post.id);
      const skipped = info.mock.calls.filter((a) => a[0] === "moderation notice skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]![1]).toEqual({ actionId, reason: "author_anonymised" });
      expect(JSON.stringify(info.mock.calls)).not.toContain(email);
    } finally {
      info.mockRestore();
    }
  });

  it("a RESTORE of never-hidden content by an anonymised author is a dismissal: 200, 0 sends, NO skip line", async () => {
    const { userId } = await seedAnonymisedUser();
    const post = await seedPost(userId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      sentEmails = [];
      const res = await decide({ subject: "post", subjectId: post.id, decision: "restore", reason: "Mistaken." });
      expect(res.status).toBe(200);
      expect(sentEmails).toHaveLength(0);
      expect(warn.mock.calls.filter((a) => a[0] === "moderation notice skipped")).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["keep_hidden", "remove"] as const)("%s on an anonymised author's post DOES log the skip", async (decision) => {
    const { userId } = await seedAnonymisedUser();
    const post = await seedPost(userId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const res = await decide({ subject: "post", subjectId: post.id, decision, reason: "Violates." });
      expect(res.status).toBe(200);
      expect(warn.mock.calls.filter((a) => a[0] === "moderation notice skipped")).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// #57 gap 2 — `violationCategory` on a content decision. Internal audit /
// DSA-transparency metadata: recorded on the moderation_actions row, NEVER
// shown to the author.
describe("POST /admin/decision — violationCategory (#57 gap 2)", () => {
  async function actionRow(subjectId: string): Promise<Record<string, unknown> | null> {
    return ctxRun(async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `SELECT action, actor_admin, reason, violation_category, action_expires_at, internal_note,
                post_id, comment_id, subject_label
           FROM moderation_actions WHERE post_id = $1 OR comment_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [subjectId],
      );
      return rows[0] ?? null;
    });
  }

  it("CHARACTERISATION: a decision with NO category leaves it NULL and the other columns as before", async () => {
    const { postId } = await seedHiddenPost();
    const res = await decide({ subject: "post", subjectId: postId, decision: "remove", reason: "Because." });
    expect(res.status).toBe(200);
    expect(await actionRow(postId)).toEqual({
      action: "content_remove", actor_admin: adminEmail, reason: "Because.",
      violation_category: null, action_expires_at: null, internal_note: null,
      post_id: postId, comment_id: null, subject_label: expect.stringContaining("@example.com"),
    });
  });

  it.each(["keep_hidden", "remove"] as const)("%s records the category on the action row", async (decision) => {
    const { postId } = await seedReportedButVisiblePost();
    const res = await decide({ subject: "post", subjectId: postId, decision, reason: "x", violationCategory: "harassment" });
    expect(res.status).toBe(200);
    expect(await actionRow(postId)).toMatchObject({ violation_category: "harassment" });
  });

  it("records the category for a COMMENT decision", async () => {
    const { commentId } = await seedHiddenComment();
    const res = await decide({ subject: "comment", subjectId: commentId, decision: "remove", reason: "x", violationCategory: "spam" });
    expect(res.status).toBe(200);
    expect(await actionRow(commentId)).toMatchObject({ violation_category: "spam" });
  });

  it.each(["spam", "harassment", "hate", "sexual", "violence", "ip_infringement", "other"] as const)(
    "accepts %s", async (cat) => {
      const { postId } = await seedHiddenPost();
      expect((await decide({ subject: "post", subjectId: postId, decision: "remove", reason: "x", violationCategory: cat })).status).toBe(200);
      expect(await actionRow(postId)).toMatchObject({ violation_category: cat });
    });

  it.each(["banana", "", 7, null, "SPAM"] as const)("400s an invalid category %j BEFORE any write", async (bad) => {
    const { postId } = await seedHiddenPost();
    const before = await actionCount();
    const res = await decide({ subject: "post", subjectId: postId, decision: "remove", reason: "x", violationCategory: bad as never });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: { code?: string } | string })).toMatchObject({});
    expect(await actionCount()).toBe(before);
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
    expect(await lastActionFor(postId)).toBeNull();
    expect(sentEmails).toHaveLength(0);
  });

  it("400s a category on a restore (meaningless; same shape as legalHold + restore) and writes nothing", async () => {
    const { postId, hiddenAt } = await seedHiddenPost();
    const before = await actionCount();
    const res = await decide({ subject: "post", subjectId: postId, decision: "restore", reason: "x", violationCategory: "spam" });
    expect(res.status).toBe(400);
    expect(await actionCount()).toBe(before);
    expect(await hiddenAtOf("posts", postId)).toEqual(hiddenAt);
  });

  it("works together with a legal hold", async () => {
    const { postId } = await seedHiddenPost();
    const res = await call("/admin/decision", {
      method: "POST",
      headers: { "content-type": "application/json", ...await adminHeaders(), Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({
        subject: "post", subjectId: postId, decision: "remove", reason: "x",
        violationCategory: "sexual", legalHold: true, legalHoldCategory: "csam",
      }),
    });
    expect(res.status).toBe(200);
    expect(await actionRow(postId)).toMatchObject({ violation_category: "sexual" });
    const holds = await ctxRun(async (c) => {
      const { rows } = await c.query(`SELECT 1 FROM account_legal_holds WHERE category = 'csam' AND user_id = (SELECT author_id FROM posts WHERE id = $1)`, [postId]);
      return rows.length;
    });
    expect(holds).toBe(1);
  });

  it("the category is NOT in the author's notice", async () => {
    const { postId } = await seedHiddenPost();
    await decide({ subject: "post", subjectId: postId, decision: "remove", reason: "Plain reason.", violationCategory: "ip_infringement" });
    expect(sentEmails).toHaveLength(1);
    const text = JSON.stringify(sentEmails[0]);
    expect(text).toContain("Plain reason.");
    expect(text).not.toContain("ip_infringement");
    expect(text).not.toMatch(/violation/i);
  });
});

// #57 Art. 17 PR-A — what prompted a decision, and its recorded duration/scope.
describe("POST /admin/decision — #57 source, expiry and scope", () => {
  async function post(body: Record<string, unknown>): Promise<Response> {
    return call("/admin/decision", {
      method: "POST",
      headers: { "content-type": "application/json", ...await adminHeaders(), Origin: ALLOWED_ORIGIN },
      body: JSON.stringify(body),
    });
  }

  async function row(subjectId: string): Promise<{
    source: string | null; dsa_notice_id: string | null; action_expires_at: Date | null; territorial_scope: string;
  }> {
    return ctxRun(async (c) => {
      const { rows } = await c.query(
        `SELECT source, dsa_notice_id, action_expires_at, territorial_scope FROM moderation_actions
          WHERE post_id = $1 OR comment_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [subjectId],
      );
      return rows[0];
    });
  }

  async function seedNotice(postId: string, createdAt: string): Promise<string> {
    return ctxRun(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO dsa_notices
           (reporter_email, reporter_name, good_faith, verify_token_hash, target_kind, target_label, post_id,
            reason, statement, email_verified_at, created_at)
         VALUES ($1, 'A Reporter', true, $2, 'post', 'label', $3, 'spam', 'This violates the rules.', now(), $4)
         RETURNING id`,
        [`rep-${crypto.randomUUID()}@example.test`, `hash-${crypto.randomUUID()}`, postId, createdAt],
      );
      return rows[0]!.id;
    });
  }

  it("a decision with no notice and no report is own_initiative, global, no expiry", async () => {
    const postId = (await seedPost(await seedUser())).id;
    expect((await post({ subject: "post", subjectId: postId, decision: "keep_hidden", reason: "r" })).status).toBe(200);
    expect(await row(postId)).toMatchObject({
      source: "own_initiative", dsa_notice_id: null, action_expires_at: null, territorial_scope: "global",
    });
  });

  it("an unhandled member report makes the source member_report", async () => {
    const { postId } = await seedReportedButVisiblePost();
    await post({ subject: "post", subjectId: postId, decision: "keep_hidden", reason: "r" });
    expect(await row(postId)).toMatchObject({ source: "member_report", dsa_notice_id: null });
  });

  it("a report that an earlier ruling already handled does not count", async () => {
    const { postId } = await seedReportedButVisiblePost();
    await post({ subject: "post", subjectId: postId, decision: "keep_hidden", reason: "first" });
    await post({ subject: "post", subjectId: postId, decision: "remove", reason: "second" });
    expect(await row(postId)).toMatchObject({ source: "own_initiative" });
  });

  it("a confirmed notice makes the source dsa_notice and stores the OLDEST notice's id", async () => {
    const { postId } = await seedReportedButVisiblePost();
    const older = await seedNotice(postId, "2026-01-01T00:00:00Z");
    const newer = await seedNotice(postId, "2026-02-01T00:00:00Z");
    await post({ subject: "post", subjectId: postId, decision: "remove", reason: "r" });
    const r = await row(postId);
    expect(r).toMatchObject({ source: "dsa_notice", dsa_notice_id: older });
    const resolved = await ctxRun(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM dsa_notices WHERE id = ANY($1::uuid[]) AND resolved_at IS NOT NULL AND resolution_action_id IS NOT NULL`,
        [[older, newer]],
      );
      return rows.length;
    });
    expect(resolved).toBe(2);
  });

  it("notice outbox PR 2: EACH resolved notice's reporter gets its own queued outcome (two notices, two rows), none sent by the request", async () => {
    const { postId } = await seedReportedButVisiblePost();
    const n1 = await seedNotice(postId, "2026-01-01T00:00:00Z");
    const n2 = await seedNotice(postId, "2026-02-01T00:00:00Z");
    const res = await decideQueuedOnly({ subject: "post", subjectId: postId, decision: "remove", reason: "r" });
    expect(res.status).toBe(200);
    const { actionId } = (await res.json()) as { actionId: string };

    const rows = await reporterRows(actionId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dsa_notice_id).sort()).toEqual([n1, n2].sort());
    for (const r of rows) {
      expect(r).toMatchObject({ kind: "reporter_outcome", state: "pending", recipient_user_id: null });
      expect(r.recipient_email).toMatch(/^rep-.*@example\.test$/);
    }
  });

  it("durationHours records action_expires_at on a keep_hidden", async () => {
    const postId = (await seedPost(await seedUser())).id;
    const before = Date.now();
    const res = await post({ subject: "post", subjectId: postId, decision: "keep_hidden", reason: "r", durationHours: 24 });
    expect(res.status).toBe(200);
    const exp = (await row(postId)).action_expires_at!.getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 24 * 3_600_000 - 1000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000 + 1000);
  });

  it("400s durationHours on a restore, and a value outside the allowed list", async () => {
    const { postId } = await seedHiddenPost();
    const before = await actionCount();
    expect((await post({ subject: "post", subjectId: postId, decision: "restore", reason: "r", durationHours: 24 })).status).toBe(400);
    expect((await post({ subject: "post", subjectId: postId, decision: "remove", reason: "r", durationHours: 5 })).status).toBe(400);
    expect(await actionCount()).toBe(before);
  });

  it("⚠️ a content row with an expiry cannot change an account-level result", async () => {
    // appeals.ts recomputes suspended_until from user_suspend rows only.
    const userId = await seedUser();
    const postId = (await seedPost(userId)).id;
    await post({ subject: "post", subjectId: postId, decision: "remove", reason: "r", durationHours: 720 });
    const leaked = await ctxRun(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM moderation_actions
          WHERE subject_user_id = $1 AND action_expires_at IS NOT NULL
            AND action IN ('user_warn','user_suspend','user_ban','user_terminate')`,
        [userId],
      );
      return Number(rows[0]!.n);
    });
    expect(leaked).toBe(0);
  });
});

// #57 Art. 17 PR-C — the structured grounds (legal_ground / contractual_ground).
describe("POST /admin/decision — #57 grounds", () => {
  async function post(body: Record<string, unknown>): Promise<Response> {
    return call("/admin/decision", {
      method: "POST",
      headers: { "content-type": "application/json", ...await adminHeaders(), Origin: ALLOWED_ORIGIN },
      body: JSON.stringify(body),
    });
  }

  async function grounds(subjectId: string): Promise<{ legal_ground: string | null; contractual_ground: string | null }> {
    return ctxRun(async (c) => {
      const { rows } = await c.query(
        `SELECT legal_ground, contractual_ground FROM moderation_actions
          WHERE post_id = $1 OR comment_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [subjectId],
      );
      return rows[0];
    });
  }

  it("stores both grounds independently on a remove", async () => {
    const postId = (await seedPost(await seedUser())).id;
    const res = await post({
      subject: "post", subjectId: postId, decision: "remove", reason: "r",
      legalGround: "copyright_infringement", contractualGround: "guidelines_ip",
    });
    expect(res.status).toBe(200);
    expect(await grounds(postId)).toEqual({ legal_ground: "copyright_infringement", contractual_ground: "guidelines_ip" });
  });

  it("stores one ground alone, leaving the other NULL", async () => {
    const postId = (await seedPost(await seedUser())).id;
    expect((await post({ subject: "post", subjectId: postId, decision: "keep_hidden", reason: "r", contractualGround: "guidelines_spam" })).status).toBe(200);
    expect(await grounds(postId)).toEqual({ legal_ground: null, contractual_ground: "guidelines_spam" });
  });

  it("an old-style request (neither field) still succeeds and stores NULLs", async () => {
    const postId = (await seedPost(await seedUser())).id;
    expect((await post({ subject: "post", subjectId: postId, decision: "remove", reason: "r" })).status).toBe(200);
    expect(await grounds(postId)).toEqual({ legal_ground: null, contractual_ground: null });
  });

  it("400s an unknown value, a wrong type, and either ground on a restore, writing nothing", async () => {
    const { postId } = await seedHiddenPost();
    const before = await actionCount();
    const base = { subject: "post", subjectId: postId, reason: "r" };
    expect((await post({ ...base, decision: "remove", legalGround: "treason" })).status).toBe(400);
    expect((await post({ ...base, decision: "remove", contractualGround: "vibes" })).status).toBe(400);
    expect((await post({ ...base, decision: "remove", legalGround: 7 })).status).toBe(400);
    expect((await post({ ...base, decision: "restore", legalGround: "csam" })).status).toBe(400);
    expect((await post({ ...base, decision: "restore", contractualGround: "guidelines_spam" })).status).toBe(400);
    expect(await actionCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Notice outbox PR 1 (#57 gap 1): the author's notice is rendered and queued
// INSIDE the decision's transaction; the request never calls Postmark.
// ---------------------------------------------------------------------------
describe("POST /admin/decision — notice outbox (PR 1)", () => {
  async function authorIdOfPost(postId: string): Promise<string> {
    return ctxRun(async (c) => {
      const { rows } = await c.query<{ author_id: string }>(`SELECT author_id FROM posts WHERE id = $1`, [postId]);
      return rows[0]!.author_id;
    });
  }

  it("keep_hidden queues exactly ONE author_decision row (appeal link, dispute line) and does NOT call Postmark in the request", async () => {
    const { postId, authorEmail } = await seedHiddenPost();
    const res = await decideQueuedOnly({ subject: "post", subjectId: postId, decision: "keep_hidden", reason: "Violates the guidelines." });
    expect(res.status).toBe(200);
    const { actionId } = (await res.json()) as { actionId: string };

    // The request sent nothing.
    expect(sentEmails).toHaveLength(0);

    const rows = await outboxRows(actionId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      kind: "author_decision", state: "pending", attempts: 0, delivered_at: null, last_error: null,
      recipient_email: null, subject: "Your content remains hidden after review",
    });
    expect(row.recipient_user_id).toBe(await authorIdOfPost(postId));
    expect(row.body_text).toContain("Violates the guidelines.");
    expect(row.body_text).toContain("/appeal?token=");
    expect(row.body_html).toContain("/appeal?token=");
    expect(row.body_text).toContain(DISPUTE_CONTACT_LINE);
    expect(row.body_html).toContain(DISPUTE_CONTACT_LINE);
    // An account recipient's address is re-read at send time, never stored.
    expect(JSON.stringify(row)).not.toContain(authorEmail);

    // The appeal token was minted in the same transaction, valid for the undeliverable horizon plus the window
    // (the window itself starts at delivery; the drain shortens the link then).
    expect(await appealTokenCount(actionId)).toBe(1);
    const ttl = await ctxRun(async (c) => {
      const { rows: t } = await c.query<{ ok: boolean }>(
        `SELECT (expires_at > now() + make_interval(days => $2::int - 1) AND expires_at <= now() + make_interval(days => $2::int)) AS ok
           FROM moderation_action_tokens WHERE action_id = $1`,
        [actionId, APPEAL_WINDOW_DAYS + NOTICE_UNDELIVERABLE_HORIZON_DAYS],
      );
      return t[0]!.ok;
    });
    expect(ttl).toBe(true);
  });

  it("retain_until is the decision's created_at plus the retention constant (365 days)", async () => {
    expect(MODERATION_NOTICE_RETENTION_DAYS).toBe(365);
    const { postId } = await seedHiddenPost();
    const res = await decideQueuedOnly({ subject: "post", subjectId: postId, decision: "remove", reason: "x" });
    const { actionId } = (await res.json()) as { actionId: string };
    const { rows: actionRows } = await ctxRun((c) =>
      c.query<{ created_at: Date }>(`SELECT created_at FROM moderation_actions WHERE id = $1`, [actionId]),
    );
    const [row] = await outboxRows(actionId);
    const expected = actionRows[0]!.created_at.getTime() + MODERATION_NOTICE_RETENTION_DAYS * 86_400_000;
    // Day arithmetic in SQL is timezone-sensitive across DST; allow one hour.
    expect(Math.abs(row!.retain_until.getTime() - expected)).toBeLessThanOrEqual(3_600_000);
  });

  it("the drain then sends the queued notice once, stamps delivered_at and leaves no live link in the stored copy", async () => {
    const { postId, authorEmail } = await seedHiddenPost();
    const res = await decideQueuedOnly({ subject: "post", subjectId: postId, decision: "remove", reason: "x" });
    const { actionId } = (await res.json()) as { actionId: string };
    const [queued] = await outboxRows(actionId);

    const ctx = createExecutionContext();
    const counts = await drainNoticeOutbox(env, ctx, { onlyActionIds: [actionId] });
    await waitOnExecutionContext(ctx);

    expect(counts).toMatchObject({ leased: 1, delivered: 1 });
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({ To: authorEmail, MessageStream: "outbound" });
    // What was mailed is what was queued, link included.
    expect(String(sentEmails[0]!["TextBody"])).toBe(queued!.body_text);
    expect(String(sentEmails[0]!["TextBody"])).toContain("/appeal?token=");

    const [after] = await outboxRows(actionId);
    expect(after).toMatchObject({ state: "delivered" });
    expect(after!.delivered_at).not.toBeNull();
    expect(after!.body_text).not.toContain("token=");
    expect(after!.body_html).not.toContain("token=");
  });

  it("restore of HIDDEN content queues a notice with the dispute line and NO appeal link or token", async () => {
    const { postId } = await seedHiddenPost();
    const res = await decideQueuedOnly({ subject: "post", subjectId: postId, decision: "restore", reason: "Mistaken." });
    expect(res.status).toBe(200);
    const { actionId } = (await res.json()) as { actionId: string };
    const rows = await outboxRows(actionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "author_decision", subject: "Your content has been restored" });
    expect(rows[0]!.body_text).toContain(DISPUTE_CONTACT_LINE);
    expect(rows[0]!.body_text).not.toContain("/appeal?token=");
    expect(await appealTokenCount(actionId)).toBe(0);
  });

  it("restore of NEVER-hidden content (a dismissal) queues nothing and mints nothing", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId);
    await seedReport(post.id);
    const res = await decideQueuedOnly({ subject: "post", subjectId: post.id, decision: "restore", reason: "Mistaken." });
    expect(res.status).toBe(200);
    const { actionId } = (await res.json()) as { actionId: string };
    // Control: the decision itself was applied and recorded.
    expect(await lastActionFor(post.id)).toMatchObject({ action: "content_restore" });
    expect(await outboxRows(actionId)).toHaveLength(0);
    expect(await appealTokenCount(actionId)).toBe(0);
  });

  it("an ANONYMISED author: decision applied, nothing queued, no token, and the skip is still logged (action id and reason only)", async () => {
    const userId = await seedUser();
    const email = `deleted-${userId}@invalid.thinkersjournal.local`;
    await ctxRun(async (c) => {
      await c.query(`UPDATE users SET email = $2, anonymised_at = now() WHERE id = $1`, [userId, email]);
    });
    const post = await seedPost(userId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await decideQueuedOnly({ subject: "post", subjectId: post.id, decision: "remove", reason: "x" });
    expect(res.status).toBe(200);
    const { actionId } = (await res.json()) as { actionId: string };
    expect(await lastActionFor(post.id)).toMatchObject({ action: "content_remove" });
    expect(await outboxRows(actionId)).toHaveLength(0);
    expect(await appealTokenCount(actionId)).toBe(0);
    const skipped = warn.mock.calls.filter((a) => a[0] === "moderation notice skipped");
    expect(skipped).toEqual([["moderation notice skipped", { actionId, reason: "author_anonymised" }]]);
  });

  it("a retried enqueue for the same (action, kind) is a no-op: one row", async () => {
    const userId = await seedUser();
    const actionId = crypto.randomUUID();
    // A restore of hidden content mints no token, so no moderation_actions row is needed.
    const input = {
      actionId, authorId: userId, decision: "restore", wasHidden: true, subject: "post",
      postTitle: "T", reason: "r", origin: "https://community.thinkersjournal.com",
    } as const;
    expect(await ctxRun((c) => enqueueAuthorDecisionNotice(c, input))).toBe(true);
    expect(await ctxRun((c) => enqueueAuthorDecisionNotice(c, input))).toBe(true);
    expect(await outboxRows(actionId)).toHaveLength(1);
  });
});
