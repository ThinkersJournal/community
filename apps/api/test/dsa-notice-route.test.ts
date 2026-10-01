import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createPostRequest, createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";
import { awaitLimiterBurstWindow } from "./helpers/limiter-window";

import type { Actor } from "./actor";

/**
 * `POST /dsa-notice` — DSA Art. 16 notice-and-action intake (spec §8, part of
 * #113). Runs in the POOL project (real workerd): needs `HYPERDRIVE_FRESH` and
 * `DSA_LIMITER`.
 *
 * ⚠️ Global `fetch` is stubbed (Turnstile + Postmark) in every case that needs
 * it — see `stubFetch`. Mirrors test/forgot-password.test.ts.
 */

const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Same stub shape as test/forgot-password.test.ts's — both outbound calls this route can make. */
function stubFetch(turnstileSuccess: boolean): RequestInit[] {
  const postmarkCalls: RequestInit[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.startsWith("https://challenges.cloudflare.com/")) {
        return new Response(JSON.stringify({ success: turnstileSuccess }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://api.postmarkapp.com/")) {
        postmarkCalls.push(init ?? {});
        return new Response(JSON.stringify({ ErrorCode: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );

  return postmarkCalls;
}

function postmarkBody(calls: RequestInit[], index = 0): Record<string, unknown> {
  return JSON.parse(String(calls[index]!.body)) as Record<string, unknown>;
}

function validBody(target: { postId?: string; commentId?: string }) {
  return {
    ...target,
    reason: "spam",
    statement: "This content infringes my rights.",
    reporterName: "Jane Reporter",
    reporterEmail: `notice_${crypto.randomUUID().replace(/-/g, "")}@example.com`,
    goodFaith: true,
    turnstileToken: "dummy-turnstile-token",
  };
}

/**
 * A fresh, per-call TEST-NET-3 address (203.0.113.0/24) — this route's
 * `DSA_LIMITER` is keyed on IP ALONE (no session, no email to bucket by, see
 * src/routes/dsa-notice.ts), so every case that does not deliberately share a
 * bucket (the 429 burst test below) needs its own IP, or it collides with
 * every OTHER case in this file inside the same 60s window.
 */
function uniqueIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
}

function dsaNoticeRequest(
  body: unknown,
  headers: Record<string, string> = { Origin: ALLOWED_ORIGIN },
): Request {
  return new Request("https://api.test/dsa-notice", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": uniqueIp(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function dsaNotice(body: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetchWorker(dsaNoticeRequest(body, headers));
}

interface NoticeRow {
  id: string;
  email_verified_at: string | null;
  verify_token_hash: string;
}

async function noticeRowsFor(reporterEmail: string): Promise<NoticeRow[]> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<NoticeRow>(
      "SELECT id, email_verified_at::text AS email_verified_at, verify_token_hash FROM dsa_notices WHERE reporter_email = $1",
      [reporterEmail],
    );
    return rows;
  });
  await waitOnExecutionContext(ctx);
  return rows;
}

async function hidePost(postId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE posts SET hidden_at = now() WHERE id = $1", [postId]),
  );
  await waitOnExecutionContext(ctx);
}

async function postHiddenAt(postId: string): Promise<string | null> {
  const ctx = createExecutionContext();
  const hiddenAt = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ hidden_at: string | null }>(
      "SELECT hidden_at::text AS hidden_at FROM posts WHERE id = $1",
      [postId],
    );
    return rows[0]?.hidden_at ?? null;
  });
  await waitOnExecutionContext(ctx);
  return hiddenAt;
}

async function reportRowCount(postId: string): Promise<number> {
  const ctx = createExecutionContext();
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query("SELECT 1 FROM reports WHERE post_id = $1", [postId]);
    return rows.length;
  });
  await waitOnExecutionContext(ctx);
  return n;
}

async function createDraft(actor: Actor): Promise<string> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(createPostRequest(actor, "draft"), env, ctx);
  await waitOnExecutionContext(ctx);
  if (response.status !== 201) {
    throw new Error(`fixture create failed: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

async function createComment(actor: Actor, postId: string): Promise<string> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://api.test/comments", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ postId, markdownSource: "a test comment" }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  if (response.status !== 201) {
    throw new Error(`fixture create failed: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

async function hideComment(commentId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE comments SET hidden_at = now() WHERE id = $1", [commentId]),
  );
  await waitOnExecutionContext(ctx);
}

async function deleteComment(commentId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE comments SET deleted_at = now() WHERE id = $1", [commentId]),
  );
  await waitOnExecutionContext(ctx);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await deleteCreatedUsers();
});

describe("POST /dsa-notice", () => {
  it("202s a valid notice on a published, visible post and mails a confirmation link", async () => {
    const postmarkCalls = stubFetch(true);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const body = validBody({ postId });

    const response = await dsaNotice(body);
    expect(response.status).toBe(202);

    const rows = await noticeRowsFor(String(body.reporterEmail));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email_verified_at).toBeNull();
    expect(rows[0]!.verify_token_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(postmarkCalls).toHaveLength(1);
    const mail = postmarkBody(postmarkCalls);
    expect(mail.To).toBe(body.reporterEmail);
    const link = /\/dsa-notice\/confirm\?token=([^"\\<\s]+)/.exec(String(mail.TextBody));
    expect(link, "no confirmation link found in the mailed body").not.toBeNull();
    const rawToken = decodeURIComponent(link![1]!);
    // The raw token appears in the email but never in the row.
    expect(rawToken).not.toBe(rows[0]!.verify_token_hash);
    expect(String(mail.TextBody)).not.toContain(rows[0]!.verify_token_hash);
  });

  // ⚠️ AC-1, intake half: filing a notice never touches reports or hidden_at.
  it("AC-1: filing a notice creates no reports row and leaves posts.hidden_at unchanged", async () => {
    stubFetch(true);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);

    const response = await dsaNotice(validBody({ postId }));
    expect(response.status).toBe(202);

    expect(await reportRowCount(postId)).toBe(0);
    expect(await postHiddenAt(postId)).toBeNull();
  });

  describe("Review Focus 3: a notice against non-public state 404s identically, with no row and no email", () => {
    it("a hidden post", async () => {
      const postmarkCalls = stubFetch(true);
      const author = await createVerifiedActor();
      const postId = await createPublished(author);
      await hidePost(postId);
      const body = validBody({ postId });

      const response = await dsaNotice(body);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("NOT_FOUND");
      expect(await noticeRowsFor(String(body.reporterEmail))).toHaveLength(0);
      expect(postmarkCalls).toHaveLength(0);
    });

    it("a draft post", async () => {
      const postmarkCalls = stubFetch(true);
      const author = await createVerifiedActor();
      const postId = await createDraft(author);
      const body = validBody({ postId });

      const response = await dsaNotice(body);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("NOT_FOUND");
      expect(await noticeRowsFor(String(body.reporterEmail))).toHaveLength(0);
      expect(postmarkCalls).toHaveLength(0);
    });

    it("a nonexistent post uuid", async () => {
      const postmarkCalls = stubFetch(true);
      const body = validBody({ postId: crypto.randomUUID() });

      const response = await dsaNotice(body);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("NOT_FOUND");
      expect(await noticeRowsFor(String(body.reporterEmail))).toHaveLength(0);
      expect(postmarkCalls).toHaveLength(0);
    });

    it("a hidden comment", async () => {
      const postmarkCalls = stubFetch(true);
      const author = await createVerifiedActor();
      const postId = await createPublished(author);
      const commentId = await createComment(author, postId);
      await hideComment(commentId);
      const body = validBody({ commentId });

      const response = await dsaNotice(body);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("NOT_FOUND");
      expect(await noticeRowsFor(String(body.reporterEmail))).toHaveLength(0);
      expect(postmarkCalls).toHaveLength(0);
    });

    it("a deleted comment", async () => {
      const postmarkCalls = stubFetch(true);
      const author = await createVerifiedActor();
      const postId = await createPublished(author);
      const commentId = await createComment(author, postId);
      await deleteComment(commentId);
      const body = validBody({ commentId });

      const response = await dsaNotice(body);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("NOT_FOUND");
      expect(await noticeRowsFor(String(body.reporterEmail))).toHaveLength(0);
      expect(postmarkCalls).toHaveLength(0);
    });

    it("every one of the above 404s byte-identically", async () => {
      stubFetch(true);
      const author = await createVerifiedActor();
      const hiddenPostId = await createPublished(author);
      await hidePost(hiddenPostId);
      const draftPostId = await createDraft(author);
      const nonexistentId = crypto.randomUUID();
      const postId = await createPublished(author);
      const hiddenCommentId = await createComment(author, postId);
      await hideComment(hiddenCommentId);

      const bodies = [
        { postId: hiddenPostId },
        { postId: draftPostId },
        { postId: nonexistentId },
        { commentId: hiddenCommentId },
      ];

      const texts = await Promise.all(
        bodies.map(async (target) => {
          const response = await dsaNotice(validBody(target));
          expect(response.status).toBe(404);
          return response.text();
        }),
      );
      expect(new Set(texts).size).toBe(1);
    });
  });

  it("400s INVALID_INPUT for goodFaith: false, with no row", async () => {
    stubFetch(true);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const body = { ...validBody({ postId }), goodFaith: false };

    const response = await dsaNotice(body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
    expect(await noticeRowsFor(String(body.reporterEmail))).toHaveLength(0);
  });

  it("400s INVALID_INPUT when both postId and commentId are set, with no row", async () => {
    stubFetch(true);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const commentId = await createComment(author, postId);
    const body = { ...validBody({ postId }), commentId };

    const response = await dsaNotice(body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
    expect(await noticeRowsFor(String(body.reporterEmail))).toHaveLength(0);
  });

  it("400s INVALID_INPUT when neither postId nor commentId is set, with no row", async () => {
    stubFetch(true);
    const body = validBody({});

    const response = await dsaNotice(body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
    expect(await noticeRowsFor(String(body.reporterEmail))).toHaveLength(0);
  });

  it("400s INVALID_INPUT for a blank statement, with no row", async () => {
    stubFetch(true);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const body = { ...validBody({ postId }), statement: "   " };

    const response = await dsaNotice(body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
    expect(await noticeRowsFor(String(body.reporterEmail))).toHaveLength(0);
  });

  it("403s a cross-site Origin before anything else — no row, no email", async () => {
    const postmarkCalls = stubFetch(true);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const body = validBody({ postId });

    const response = await dsaNotice(body, { Origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await noticeRowsFor(String(body.reporterEmail))).toHaveLength(0);
    expect(postmarkCalls).toHaveLength(0);
  });

  it("403s FORBIDDEN on a failed Turnstile challenge, with no row", async () => {
    const postmarkCalls = stubFetch(false);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const body = validBody({ postId });

    const response = await dsaNotice(body);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("FORBIDDEN");
    expect(await noticeRowsFor(String(body.reporterEmail))).toHaveLength(0);
    expect(postmarkCalls).toHaveLength(0);
  });

  /**
   * `DSA_LIMITER` is 5/60s (wrangler.jsonc) and the local pool REALLY enforces
   * it. Turnstile stubbed to BLOCK so each allowed request costs a cheap 403 —
   * the limiter counts it either way, and runs BEFORE Turnstile. A dedicated
   * `CF-Connecting-IP` (TEST-NET-3) keeps this burst isolated from every other
   * case in this file, which sends no such header and shares the "unknown"
   * bucket among themselves.
   */
  it(
    "429s the 6th request from one IP in a minute",
    async () => {
      stubFetch(false);
      const ip = "203.0.113.77";
      await awaitLimiterBurstWindow();

      for (let i = 0; i < 5; i++) {
        const response = await dsaNotice(validBody({ postId: crypto.randomUUID() }), {
          Origin: ALLOWED_ORIGIN,
          "CF-Connecting-IP": ip,
        });
        expect(response.status).toBe(403);
      }
      const limited = await dsaNotice(validBody({ postId: crypto.randomUUID() }), {
        Origin: ALLOWED_ORIGIN,
        "CF-Connecting-IP": ip,
      });
      expect(limited.status).toBe(429);
    },
    60_000,
  );
});
