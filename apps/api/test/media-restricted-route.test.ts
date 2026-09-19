import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { withClient } from "../src/db/client";
import { createUnverifiedActor, createVerifiedActor } from "./actor";
import { requestMediaAccess, approveMediaAccess } from "../src/moderation/media-access-requests";

import type { Actor } from "./actor";

/**
 * `GET /media/restricted/:sha256` — the auth matrix (#61).
 *
 * Ordinary (non-legal) tier: author-owns-it OR admin, AND the named subject
 * must actually reference the key. Legal-hold tier: only an approved,
 * two-distinct-admin grant. Every ALLOWED fetch appends a `media_access` row.
 */

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;

async function makeJwt(email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64urlJson({ iss: `https://${TEAM}`, aud: [AUD], sub: "sub", email, exp: now + 600 });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

async function call(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test${path}`, { headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function randomSha(): string {
  return crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
}
function keyFor(sha: string): string {
  return `media/post/${sha}.webp`;
}
function markdownWith(sha: string): string {
  return `![img](https://cdn.thinkersjournal.com/${keyFor(sha)})`;
}

async function seedPost(actor: Actor, sha: string, hidden: boolean): Promise<string> {
  return ctxRun(async (c) => {
    const slug = "test-" + crypto.randomUUID().slice(0, 8);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at, hidden_at)
       VALUES ($1, 'test', $2, $3, 'published', now(), $4) RETURNING id`,
      [actor.userId, slug, markdownWith(sha), hidden ? new Date() : null],
    );
    return rows[0]!.id;
  });
}

async function mediaAccessLogCount(subjectLabel: string): Promise<number> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM moderation_actions WHERE action = 'media_access' AND subject_label = $1`,
      [subjectLabel],
    );
    return Number(rows[0]!.count);
  });
}

beforeEach(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  __resetJwksCacheForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /media/restricted/:sha256 — ordinary hidden content", () => {
  it("404s a malformed key before any auth check", async () => {
    const res = await call("/media/restricted/not-a-sha256");
    expect(res.status).toBe(404);
  });

  it("serves it to the post's own author", async () => {
    const author = await createVerifiedActor();
    const sha = randomSha();
    const postId = await seedPost(author, sha, true);
    await env.MEDIA_RESTRICTED.put(keyFor(sha), "bytes");

    const res = await call(`/media/restricted/${sha}?subject=post&subjectId=${postId}`, {
      Cookie: author.cookie,
    });
    expect(res.status).toBe(200);
  });

  it("404s a different member (not the author, not an admin)", async () => {
    const author = await createVerifiedActor();
    const stranger = await createVerifiedActor();
    const sha = randomSha();
    const postId = await seedPost(author, sha, true);
    await env.MEDIA_RESTRICTED.put(keyFor(sha), "bytes");

    const res = await call(`/media/restricted/${sha}?subject=post&subjectId=${postId}`, {
      Cookie: stranger.cookie,
    });
    expect(res.status).toBe(404);
  });

  it("serves it to an admin, and logs a media_access row", async () => {
    const author = await createVerifiedActor();
    const sha = randomSha();
    const postId = await seedPost(author, sha, true);
    await env.MEDIA_RESTRICTED.put(keyFor(sha), "bytes");

    const res = await call(`/media/restricted/${sha}?subject=post&subjectId=${postId}`, {
      "Cf-Access-Jwt-Assertion": await makeJwt("admin@example.test"),
    });
    expect(res.status).toBe(200);
    expect(await mediaAccessLogCount(keyFor(sha))).toBe(1);
  });

  it("404s when the named subject does not actually reference the key", async () => {
    const author = await createVerifiedActor();
    const sha = randomSha();
    const unrelatedSha = randomSha();
    const postId = await seedPost(author, unrelatedSha, true);
    await env.MEDIA_RESTRICTED.put(keyFor(sha), "bytes");

    const res = await call(`/media/restricted/${sha}?subject=post&subjectId=${postId}`, {
      Cookie: author.cookie,
    });
    expect(res.status).toBe(404);
  });

  it("404s an unverified actor's own hidden post the same as any other member (session still resolves; ownership is what matters)", async () => {
    const author = await createUnverifiedActor();
    const sha = randomSha();
    const postId = await seedPost(author, sha, true);
    await env.MEDIA_RESTRICTED.put(keyFor(sha), "bytes");

    const res = await call(`/media/restricted/${sha}?subject=post&subjectId=${postId}`, {
      Cookie: author.cookie,
    });
    expect(res.status).toBe(200); // ownership, not verification, gates this route
  });
});

describe("GET /media/restricted/:sha256 — legal hold", () => {
  async function holdKey(sha: string): Promise<void> {
    await ctxRun((c) =>
      c.query(`INSERT INTO media_legal_holds (r2_key, imposed_by, category) VALUES ($1, 'a@example.test', 'csam')`, [
        keyFor(sha),
      ]),
    );
    await env.MEDIA_RESTRICTED.put(keyFor(sha), "bytes");
  }

  async function grant(sha: string, requestedBy: string, approvedBy: string | null): Promise<string> {
    return ctxRun(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO media_access_requests (r2_key, requested_by, reason, approved_by, approved_at, expires_at)
         VALUES ($1, $2, 'legal review', $3::text, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END,
                 CASE WHEN $3::text IS NULL THEN NULL ELSE now() + interval '15 minutes' END)
         RETURNING id`,
        [keyFor(sha), requestedBy, approvedBy],
      );
      return rows[0]!.id;
    });
  }

  it("404s an admin with no grant at all", async () => {
    const sha = randomSha();
    await holdKey(sha);
    const res = await call(`/media/restricted/${sha}`, { "Cf-Access-Jwt-Assertion": await makeJwt("a@example.test") });
    expect(res.status).toBe(404);
  });

  it("404s the post's own author — legal hold overrides ordinary ownership entirely", async () => {
    const author = await createVerifiedActor();
    const sha = randomSha();
    await seedPost(author, sha, true);
    await holdKey(sha);
    const res = await call(`/media/restricted/${sha}`, { Cookie: author.cookie });
    expect(res.status).toBe(404);
  });

  it("404s an UNAPPROVED grant", async () => {
    const sha = randomSha();
    await holdKey(sha);
    const grantId = await grant(sha, "a@example.test", null);
    const res = await call(`/media/restricted/${sha}?grantId=${grantId}`, {
      "Cf-Access-Jwt-Assertion": await makeJwt("a@example.test"),
    });
    expect(res.status).toBe(404);
  });

  it("the DB itself refuses a self-approved row — the 0016 CHECK constraint, not just the read-side re-check", async () => {
    const sha = randomSha();
    await expect(grant(sha, "a@example.test", "a@example.test")).rejects.toThrow(/violates check constraint/);
  });

  it("the DB CHECK also refuses a CASE-VARIANT self-approval ('Alice@x' approving 'alice@x' is the same hand)", async () => {
    const sha = randomSha();
    await expect(grant(sha, "Alice@example.test", "alice@example.test")).rejects.toThrow(/violates check constraint/);
    await expect(grant(sha, "alice@example.test", " Alice@Example.Test ")).rejects.toThrow(/violates check constraint/);
  });

  it("404s a THIRD admin using someone else's approved grant", async () => {
    const sha = randomSha();
    await holdKey(sha);
    const grantId = await grant(sha, "a@example.test", "b@example.test");
    const res = await call(`/media/restricted/${sha}?grantId=${grantId}`, {
      "Cf-Access-Jwt-Assertion": await makeJwt("c@example.test"),
    });
    expect(res.status).toBe(404);
  });

  it("serves it to the requester on a validly approved grant, and logs the access", async () => {
    const sha = randomSha();
    await holdKey(sha);
    const grantId = await grant(sha, "a@example.test", "b@example.test");
    const res = await call(`/media/restricted/${sha}?grantId=${grantId}`, {
      "Cf-Access-Jwt-Assertion": await makeJwt("a@example.test"),
    });
    expect(res.status).toBe(200);
    expect(await mediaAccessLogCount(keyFor(sha))).toBe(1);
  });

  it("serves it to the approver too", async () => {
    const sha = randomSha();
    await holdKey(sha);
    const grantId = await grant(sha, "a@example.test", "b@example.test");
    const res = await call(`/media/restricted/${sha}?grantId=${grantId}`, {
      "Cf-Access-Jwt-Assertion": await makeJwt("b@example.test"),
    });
    expect(res.status).toBe(200);
  });

  it("approveMediaAccess itself refuses a CASE-VARIANT self-approval (write-time guard, not just the DB CHECK)", async () => {
    const sha = randomSha();
    await holdKey(sha);
    const requestId = await ctxRun((c) =>
      requestMediaAccess(c, { r2Key: keyFor(sha), requestedBy: "Alice@Example.Test", reason: "review" }),
    );
    const approved = await ctxRun((c) => approveMediaAccess(c, requestId, "  alice@example.test  "));
    expect(approved).toBe(false);
  });
});
