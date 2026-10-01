import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { __resetJwksCacheForTests } from "../src/admin/access-jwt";
import { withClient } from "../src/db/client";
import { applyDecision } from "../src/moderation/decide";

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

async function adminHeaders(): Promise<Record<string, string>> {
  return { "Cf-Access-Jwt-Assertion": await makeJwt() };
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

async function seedPost(userId: string, hiddenAt?: Date): Promise<{ id: string; title: string }> {
  return ctxRun(async (c) => {
    const slug = "test-" + crypto.randomUUID().slice(0, 8);
    const title = "test post " + crypto.randomUUID().slice(0, 8);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at, hidden_at)
       VALUES ($1, $2, $3, $4, 'published', now(), $5)
       RETURNING id`,
      [userId, title, slug, "test content", hiddenAt ?? null],
    );
    return { id: rows[0]!.id, title };
  });
}

/** Inserts a dsa_notices row directly, bypassing createDsaNotice's intake flow. */
async function seedDsaNotice(opts: {
  postId: string;
  confirmed?: boolean;
  reporterEmail?: string;
  reporterName?: string;
  reason?: string;
  statement?: string;
}): Promise<{ id: string; reporterEmail: string }> {
  const reporterEmail = opts.reporterEmail ?? `reporter-${crypto.randomUUID()}@example.test`;
  const reporterName = opts.reporterName ?? "A Reporter";
  const confirmed = opts.confirmed ?? true;
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO dsa_notices
         (reporter_email, reporter_name, good_faith, verify_token_hash, post_id, reason, statement, email_verified_at)
       VALUES ($1, $2, true, $3, $4, $5, $6, ${confirmed ? "now()" : "NULL"})
       RETURNING id`,
      [
        reporterEmail,
        reporterName,
        `hash-${crypto.randomUUID()}`,
        opts.postId,
        opts.reason ?? "spam",
        opts.statement ?? "This content violates the rules.",
      ],
    );
    return rows[0]!.id;
  });
  return { id, reporterEmail };
}

async function dsaNoticeRow(id: string): Promise<{ resolved_at: Date | null; resolution_action_id: string | null }> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ resolved_at: Date | null; resolution_action_id: string | null }>(
      `SELECT resolved_at, resolution_action_id FROM dsa_notices WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  });
}

describe("GET /admin/dsa-notices", () => {
  it("401s without a Cloudflare Access assertion", async () => {
    const res = await call("/admin/dsa-notices");
    expect(res.status).toBe(401);
  });

  it("lists only confirmed, unresolved notices, oldest first, with target kind/id, excerpt, reason, statement, reporter name and email; an unconfirmed notice is absent", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId);
    const older = await seedDsaNotice({
      postId: post.id,
      confirmed: true,
      reporterEmail: "older@example.test",
      reporterName: "Older Reporter",
      reason: "spam",
      statement: "This is spam.",
    });
    // Ensure ordering is distinguishable even if created_at resolution is coarse.
    await ctxRun(async (c) => {
      await c.query(`UPDATE dsa_notices SET created_at = now() - interval '1 hour' WHERE id = $1`, [older.id]);
    });
    const newer = await seedDsaNotice({
      postId: post.id,
      confirmed: true,
      reporterEmail: "newer@example.test",
      reporterName: "Newer Reporter",
    });
    const unconfirmed = await seedDsaNotice({ postId: post.id, confirmed: false });

    const res = await call("/admin/dsa-notices", { headers: await adminHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notices: Array<Record<string, unknown>> };

    const ids = body.notices.map((n) => n["id"]);
    expect(ids).not.toContain(unconfirmed.id);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));

    const olderEntry = body.notices.find((n) => n["id"] === older.id)!;
    expect(olderEntry).toMatchObject({
      kind: "post",
      targetId: post.id,
      excerpt: post.title,
      reason: "spam",
      statement: "This is spam.",
      reporterName: "Older Reporter",
      reporterEmail: "older@example.test",
    });
  });
});

describe("POST /admin/decision resolves DSA notices", () => {
  it("Review Focus 4: two confirmed notices + one unconfirmed on one post are resolved by a remove decision; the unconfirmed one is untouched; both reporters are emailed the statement of reasons; the author gets their usual notice", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId);
    const confirmedA = await seedDsaNotice({ postId: post.id, confirmed: true, reporterEmail: "a@example.test" });
    const confirmedB = await seedDsaNotice({ postId: post.id, confirmed: true, reporterEmail: "b@example.test" });
    const unconfirmed = await seedDsaNotice({ postId: post.id, confirmed: false, reporterEmail: "c@example.test" });

    sentEmails = [];
    const res = await call("/admin/decision", {
      method: "POST",
      headers: { "content-type": "application/json", ...await adminHeaders(), Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ subject: "post", subjectId: post.id, decision: "remove", reason: "Confirmed violation." }),
    });
    expect(res.status).toBe(200);
    const { actionId } = (await res.json()) as { actionId: string };

    const rowA = await dsaNoticeRow(confirmedA.id);
    const rowB = await dsaNoticeRow(confirmedB.id);
    const rowC = await dsaNoticeRow(unconfirmed.id);
    expect(rowA.resolved_at).not.toBeNull();
    expect(rowA.resolution_action_id).toBe(actionId);
    expect(rowB.resolved_at).not.toBeNull();
    expect(rowB.resolution_action_id).toBe(actionId);
    expect(rowC.resolved_at).toBeNull();
    expect(rowC.resolution_action_id).toBeNull();

    // Author email + 2 reporter emails.
    expect(sentEmails).toHaveLength(3);
    const reporterEmails = sentEmails.filter((e) => e["To"] === "a@example.test" || e["To"] === "b@example.test");
    expect(reporterEmails).toHaveLength(2);
    for (const e of reporterEmails) {
      expect(String(e["TextBody"])).toContain("Confirmed violation.");
    }
  });

  it("a restore of never-hidden content (a dismissal) still resolves the notices and tells each reporter 'no action was taken'; the author gets nothing", async () => {
    const userId = await seedUser();
    const post = await seedPost(userId); // never hidden
    const notice = await seedDsaNotice({ postId: post.id, confirmed: true, reporterEmail: "reporter@example.test" });

    sentEmails = [];
    const res = await call("/admin/decision", {
      method: "POST",
      headers: { "content-type": "application/json", ...await adminHeaders(), Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ subject: "post", subjectId: post.id, decision: "restore", reason: "No violation found." }),
    });
    expect(res.status).toBe(200);

    const row = await dsaNoticeRow(notice.id);
    expect(row.resolved_at).not.toBeNull();

    // No author email (dismissal, existing behaviour); one reporter email.
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({ To: "reporter@example.test" });
    expect(String(sentEmails[0]!["TextBody"])).toContain("no action was taken");
  });

  it("a notice on a DIFFERENT post is not resolved", async () => {
    const userId = await seedUser();
    const actionedPost = await seedPost(userId);
    const otherPost = await seedPost(userId);
    const otherNotice = await seedDsaNotice({ postId: otherPost.id, confirmed: true });

    const res = await call("/admin/decision", {
      method: "POST",
      headers: { "content-type": "application/json", ...await adminHeaders(), Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ subject: "post", subjectId: actionedPost.id, decision: "remove", reason: "x" }),
    });
    expect(res.status).toBe(200);

    const row = await dsaNoticeRow(otherNotice.id);
    expect(row.resolved_at).toBeNull();
  });

  it("atomicity (failure BEFORE the resolve step): an invalid violationCategory breaks recordModerationAction's own INSERT, so the DSA UPDATE never runs and the notice is untouched", async () => {
    // ⚠️ This proves ORDERING (the resolve step is unreached), not ROLLBACK —
    // the UPDATE never executes here, so "resolved_at is null" is trivially
    // true. The test below proves the stronger claim: a failure AFTER the
    // UPDATE has already run rolls the resolution back too.
    const userId = await seedUser();
    const post = await seedPost(userId);
    const notice = await seedDsaNotice({ postId: post.id, confirmed: true });

    await expect(
      ctxRun((c) =>
        applyDecision(c, {
          subject: "post",
          subjectId: post.id,
          decision: "remove",
          reason: "x",
          actorAdmin: adminEmail,
          // Not a member of the violation_category CHECK constraint — forces
          // recordModerationAction's INSERT to fail inside the transaction,
          // BEFORE the DSA UPDATE that follows it runs at all.
          violationCategory: "not-a-real-category" as never,
        }),
      ),
    ).rejects.toThrow();

    const row = await dsaNoticeRow(notice.id);
    expect(row.resolved_at).toBeNull();
    expect(row.resolution_action_id).toBeNull();
  });

  it("atomicity (failure AFTER the resolve step): a commit-time failure rolls back a DSA resolution that already ran, along with the rest of the decision", async () => {
    // ⚠️ Unlike the test above, this forces the failure to fire AT COMMIT,
    // strictly after decide.ts's DSA UPDATE has already set resolved_at in
    // the (not yet committed) transaction. A DEFERRED constraint trigger is
    // the only deterministic way to do that from outside decide.ts: it runs
    // when COMMIT is issued, which is exactly where applyDecision's `await
    // c.query("COMMIT")` sits, after every other write in the transaction.
    // If COMMIT raises, Postgres rolls the whole transaction back for us —
    // this test is a genuine proof of atomicity, not of ordering.
    const userId = await seedUser();
    const post = await seedPost(userId);
    const notice = await seedDsaNotice({ postId: post.id, confirmed: true });
    const hiddenAtBefore = await ctxRun(async (c) => {
      const { rows } = await c.query<{ hidden_at: Date | null }>(
        `SELECT hidden_at FROM posts WHERE id = $1`,
        [post.id],
      );
      return rows[0]!.hidden_at;
    });

    // Unique per-test names: the test DB is SHARED across test files, so a
    // fixed name would collide with a concurrently-running file, and the
    // WHEN clause must scope to THIS test's notice only — a trigger that
    // fired for every row would break every other test touching dsa_notices.
    const suffix = crypto.randomUUID().replace(/-/g, "");
    const fnName = `test_fail_on_resolve_${suffix}`;
    const trgName = `test_fail_resolve_${suffix}`;

    await ctxRun(async (c) => {
      await c.query(
        `CREATE FUNCTION ${fnName}() RETURNS trigger AS $$
         BEGIN
           RAISE EXCEPTION 'forced failure after resolve';
         END;
         $$ LANGUAGE plpgsql`,
      );
      await c.query(
        `CREATE CONSTRAINT TRIGGER ${trgName}
           AFTER UPDATE ON dsa_notices
           DEFERRABLE INITIALLY DEFERRED
           FOR EACH ROW
           WHEN (NEW.id = '${notice.id}'::uuid AND NEW.resolved_at IS NOT NULL)
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
          }),
        ),
      ).rejects.toThrow(/forced failure after resolve/);

      const row = await dsaNoticeRow(notice.id);
      expect(row.resolved_at).toBeNull();
      expect(row.resolution_action_id).toBeNull();

      const hiddenAtAfter = await ctxRun(async (c) => {
        const { rows } = await c.query<{ hidden_at: Date | null }>(
          `SELECT hidden_at FROM posts WHERE id = $1`,
          [post.id],
        );
        return rows[0]!.hidden_at;
      });
      expect(hiddenAtAfter).toEqual(hiddenAtBefore);

      const actionRows = await ctxRun(async (c) => {
        const { rows } = await c.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM moderation_actions WHERE post_id = $1`,
          [post.id],
        );
        return parseInt(rows[0]!.count, 10);
      });
      expect(actionRows).toBe(0);
    } finally {
      await ctxRun(async (c) => {
        await c.query(`DROP TRIGGER IF EXISTS ${trgName} ON dsa_notices`);
        await c.query(`DROP FUNCTION IF EXISTS ${fnName}()`);
      });
    }
  });
});
