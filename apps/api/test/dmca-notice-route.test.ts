// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { reapUnconfirmedDmcaNotices, TEST_LAST_DMCA_TOKEN_KEY } from "../src/moderation/dmca-notices";
import { createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";

/**
 * DMCA takedown notice intake (ROADMAP R9): `POST /dmca-notice` and
 * `/dmca-notice/confirm`. The shape mirrors dsa-notice-route.test.ts, whose
 * helpers are copied rather than shared because that file keeps them private.
 */

const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Turnstile + Postmark stub; returns the Postmark calls. */
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

function validBody(target: { postId?: string; commentId?: string }): Record<string, unknown> {
  return {
    ...target,
    workDescription: "My essay 'On Boats', first published in 2019.",
    complainantName: "Jane Owner",
    complainantEmail: `dmca_${crypto.randomUUID().replace(/-/g, "")}@example.com`,
    complainantAddress: "1 Example Street, Exampleton",
    complainantPhone: "+1 555 0100",
    signature: "Jane Owner",
    statementGoodFaith: true,
    statementAccuracy: true,
    turnstileToken: "dummy-turnstile-token",
  };
}

/** A fresh TEST-NET-3 address per call: the limiter is keyed ip:email. */
function uniqueIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
}

function post(path: string, body: unknown, headers: Record<string, string> = { Origin: ALLOWED_ORIGIN }): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": uniqueIp(), ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function run<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const out = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return out;
}

interface NoticeRow {
  id: string;
  state: string;
  email_verified_at: string | null;
  verify_token_hash: string;
  target_kind: string;
  target_label: string;
  signature: string;
}

function noticesFor(email: string): Promise<NoticeRow[]> {
  return run(async (c) => {
    const { rows } = await c.query<NoticeRow>(
      `SELECT id, state, email_verified_at::text AS email_verified_at, verify_token_hash, target_kind,
              target_label, signature
         FROM dmca_notices WHERE complainant_email = $1`,
      [email],
    );
    return rows;
  });
}

function postHiddenAt(postId: string): Promise<string | null> {
  return run(async (c) => {
    const { rows } = await c.query<{ hidden_at: string | null }>(
      "SELECT hidden_at::text AS hidden_at FROM posts WHERE id = $1",
      [postId],
    );
    return rows[0]?.hidden_at ?? null;
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await run((c) => c.query("DELETE FROM dmca_notices WHERE complainant_email LIKE 'dmca\\_%@example.com'"));
  await deleteCreatedUsers();
});

describe("POST /dmca-notice", () => {
  it("202s a complete notice on a visible post, stores the six elements, and mails a confirmation link", async () => {
    const postmarkCalls = stubFetch(true);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const body = validBody({ postId });

    const response = await post("/dmca-notice", body);
    expect(response.status).toBe(202);

    const rows = await noticesFor(String(body.complainantEmail));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("pending");
    expect(rows[0]!.email_verified_at).toBeNull();
    expect(rows[0]!.target_kind).toBe("post");
    expect(rows[0]!.target_label.length).toBeGreaterThan(0);
    expect(rows[0]!.signature).toBe("Jane Owner");
    expect(rows[0]!.verify_token_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(postmarkCalls).toHaveLength(1);
    const mail = JSON.parse(String(postmarkCalls[0]!.body)) as Record<string, unknown>;
    expect(mail.To).toBe(body.complainantEmail);
    const link = /\/dmca\/confirm\?token=([^"\\<\s]+)/.exec(String(mail.TextBody));
    expect(link, "no confirmation link in the mailed body").not.toBeNull();
    // The raw token is mailed, never stored.
    expect(String(mail.TextBody)).not.toContain(rows[0]!.verify_token_hash);
  });

  // AC-1: a notice is queue input only. Hiding is a moderator's decision.
  it("AC-1: filing (and even confirming) a notice hides nothing and creates no reports row", async () => {
    stubFetch(true);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const body = validBody({ postId });
    expect((await post("/dmca-notice", body)).status).toBe(202);
    const token = await env.SESSIONS.get(TEST_LAST_DMCA_TOKEN_KEY);
    expect((await post("/dmca-notice/confirm", { token })).status).toBe(200);

    expect(await postHiddenAt(postId)).toBeNull();
    const reports = await run((c) => c.query("SELECT 1 FROM reports WHERE post_id = $1", [postId]));
    expect(reports.rowCount).toBe(0);
  });

  it("404s a hidden post identically to a nonexistent one, with no row and no email", async () => {
    const postmarkCalls = stubFetch(true);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await run((c) => c.query("UPDATE posts SET hidden_at = now() WHERE id = $1", [postId]));

    for (const target of [postId, crypto.randomUUID()]) {
      const body = validBody({ postId: target });
      const response = await post("/dmca-notice", body);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("NOT_FOUND");
      expect(await noticesFor(String(body.complainantEmail))).toHaveLength(0);
    }
    expect(postmarkCalls).toHaveLength(0);
  });

  it.each(["statementGoodFaith", "statementAccuracy"])(
    "400s, naming the field, when %s is not literally true; nothing is stored",
    async (field) => {
      const postmarkCalls = stubFetch(true);
      const body = { ...validBody({ postId: crypto.randomUUID() }), [field]: false };

      const response = await post("/dmca-notice", body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { fields?: string[] }).fields).toContain(field);
      expect(await noticesFor(String(body.complainantEmail))).toHaveLength(0);
      expect(postmarkCalls).toHaveLength(0);
    },
  );

  it.each(["signature", "complainantAddress", "complainantPhone", "workDescription"])(
    "400s when the %s element is missing",
    async (field) => {
      stubFetch(true);
      const body = validBody({ postId: crypto.randomUUID() });
      delete body[field];
      const response = await post("/dmca-notice", body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { fields?: string[] }).fields).toContain(field);
    },
  );

  it("403s a failed Turnstile and a wrong Origin, storing nothing", async () => {
    stubFetch(false);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const body = validBody({ postId });
    expect((await post("/dmca-notice", body)).status).toBe(403);
    stubFetch(true);
    expect((await post("/dmca-notice", body, { Origin: "https://evil.example" })).status).toBe(403);
    expect(await noticesFor(String(body.complainantEmail))).toHaveLength(0);
  });
});

describe("/dmca-notice/confirm", () => {
  it("peeks without mutating, confirms idempotently, and 400s an unknown token", async () => {
    stubFetch(true);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const body = validBody({ postId });
    expect((await post("/dmca-notice", body)).status).toBe(202);
    const token = String(await env.SESSIONS.get(TEST_LAST_DMCA_TOKEN_KEY));

    const peek = await fetchWorker(new Request(`https://api.test/dmca-notice/confirm?token=${encodeURIComponent(token)}`));
    expect(peek.status).toBe(200);
    expect((await noticesFor(String(body.complainantEmail)))[0]!.email_verified_at).toBeNull();

    expect((await post("/dmca-notice/confirm", { token })).status).toBe(200);
    const first = (await noticesFor(String(body.complainantEmail)))[0]!.email_verified_at;
    expect(first).not.toBeNull();
    expect((await post("/dmca-notice/confirm", { token })).status).toBe(200);
    expect((await noticesFor(String(body.complainantEmail)))[0]!.email_verified_at).toBe(first);

    expect((await post("/dmca-notice/confirm", { token: "nope" })).status).toBe(400);
    const badPeek = await fetchWorker(new Request("https://api.test/dmca-notice/confirm?token=nope"));
    expect(badPeek.status).toBe(400);
  });
});

describe("reapUnconfirmedDmcaNotices", () => {
  it("deletes an old unconfirmed notice, keeps a confirmed one and a fresh unconfirmed one", async () => {
    stubFetch(true);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const bodies = [0, 1, 2].map(() => validBody({ postId }));
    for (const b of bodies) expect((await post("/dmca-notice", b)).status).toBe(202);

    // [0] old and unconfirmed, [1] old and confirmed, [2] fresh and unconfirmed.
    await run(async (c) => {
      await c.query(
        "UPDATE dmca_notices SET created_at = now() - interval '30 days' WHERE complainant_email = ANY($1)",
        [[bodies[0]!.complainantEmail, bodies[1]!.complainantEmail]],
      );
      await c.query("UPDATE dmca_notices SET email_verified_at = now() WHERE complainant_email = $1", [
        bodies[1]!.complainantEmail,
      ]);
    });

    const ctx = createExecutionContext();
    const reaped = await reapUnconfirmedDmcaNotices(env, ctx);
    await waitOnExecutionContext(ctx);
    expect(reaped).toBeGreaterThanOrEqual(1);

    expect(await noticesFor(String(bodies[0]!.complainantEmail))).toHaveLength(0);
    expect(await noticesFor(String(bodies[1]!.complainantEmail))).toHaveLength(1);
    expect(await noticesFor(String(bodies[2]!.complainantEmail))).toHaveLength(1);
  });
});
