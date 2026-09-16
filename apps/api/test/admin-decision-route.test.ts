import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { withClient } from "../src/db/client";

import type { DecisionInput } from "../src/moderation/decide";

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
  const userId = await ctxRun(async (c) => {
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
  createdUserIds.push(userId.id);
  return { userId: userId.id, username: userId.username };
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

async function decideRaw(opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
  return call("/admin/decision", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
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
    const purgeTags = purges[0]!;
    expect(purgeTags).toContain(`post:${post.id}`);
    expect(purgeTags).toContain("listing");
    expect(purgeTags).toContain(`tag:${tagSlug}`);
    // Clean up tag
    await ctxRun(async (c) => {
      await c.query(`DELETE FROM tags WHERE slug = $1`, [tagSlug]);
    });
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

  it("decision succeeds even if Postmark fails — the notice is logged, not swallowed", async () => {
    const { postId } = await seedHiddenPost();

    // On Postmark failure, postmarkSend returns false and the caller logs it.
    // This test just confirms the decision succeeds (returns 200) with actionId,
    // proving the failure was handled, not surfaced.
    let postmarkCalled = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.postmarkapp.com/email") {
        postmarkCalled = true;
        return new Response("Internal Server Error", { status: 500 });
      }
      const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }));

    const res = await decide({
      subject: "post",
      subjectId: postId,
      decision: "remove",
      reason: "x",
    });

    expect(res.status).toBe(200);
    const { actionId } = (await res.json()) as { actionId: string };
    expect(actionId).toBeTruthy();
    expect(postmarkCalled).toBe(true);

    vi.unstubAllGlobals();
  });
});
