import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function report(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/reports", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function reportRowCount(reporterId: string, postId: string): Promise<number> {
  const ctx = createExecutionContext();
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      "SELECT 1 FROM reports WHERE reporter_id = $1 AND post_id = $2",
      [reporterId, postId],
    );
    return rows.length;
  });
  await waitOnExecutionContext(ctx);
  return n;
}

// `pg` returns `timestamptz` as a JS `Date`, so the column is cast to text
// here — a plain string compares cleanly with `toBe` (a `Date` does not:
// `Object.is` on two distinct `Date` instances is false even when equal).
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

let alice: Actor;
let author: Actor;
beforeAll(async () => {
  alice = await createVerifiedActor();
  author = await createVerifiedActor();
});
afterAll(async () => {
  await deleteCreatedUsers();
});

describe("POST /reports", () => {
  it("creates a report row and 201s", async () => {
    const postId = await createPublished(author);
    const response = await report(alice, { postId, reason: "spam" });
    expect(response.status).toBe(201);
    expect(await reportRowCount(alice.userId, postId)).toBe(1);
  });

  it("is idempotent for a duplicate report by the same actor on the same target", async () => {
    const postId = await createPublished(author);
    const r1 = await report(alice, { postId, reason: "spam" });
    expect(r1.status).toBe(201);
    const r2 = await report(alice, { postId, reason: "spam" });
    expect(r2.status).toBe(201);
    expect(await reportRowCount(alice.userId, postId)).toBe(1);
  });

  it("400s INVALID_REPORT_TARGET when neither postId nor commentId is set", async () => {
    const response = await report(alice, { reason: "spam" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_REPORT_TARGET");
  });

  it("400s INVALID_REPORT_TARGET when both postId and commentId are set", async () => {
    const postId = await createPublished(author);
    const response = await report(alice, {
      postId,
      commentId: crypto.randomUUID(),
      reason: "spam",
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_REPORT_TARGET");
  });

  it("404s for a nonexistent target", async () => {
    const response = await report(alice, { postId: crypto.randomUUID(), reason: "spam" });
    expect(response.status).toBe(404);
  });
});

describe("auto-hide (>=3 distinct reporters within 24h)", () => {
  it("hides the post once a 3rd distinct reporter reports it, and a 4th report is a no-op", async () => {
    const postId = await createPublished(author);
    const r1 = await createVerifiedActor();
    const r2 = await createVerifiedActor();
    const r3 = await createVerifiedActor();
    const r4 = await createVerifiedActor();

    expect((await report(r1, { postId, reason: "spam" })).status).toBe(201);
    expect((await report(r2, { postId, reason: "spam" })).status).toBe(201);
    expect(await postHiddenAt(postId)).toBeNull();

    expect((await report(r3, { postId, reason: "spam" })).status).toBe(201);
    const hiddenAt = await postHiddenAt(postId);
    expect(hiddenAt).not.toBeNull();

    // A 4th report must not un-hide or re-hide (idempotent — same timestamp).
    expect((await report(r4, { postId, reason: "spam" })).status).toBe(201);
    expect(await postHiddenAt(postId)).toBe(hiddenAt);
  });

  it("leaves hidden_at NULL with only 2 distinct reporters", async () => {
    const postId = await createPublished(author);
    const r1 = await createVerifiedActor();
    const r2 = await createVerifiedActor();

    expect((await report(r1, { postId, reason: "spam" })).status).toBe(201);
    expect((await report(r2, { postId, reason: "spam" })).status).toBe(201);
    expect(await postHiddenAt(postId)).toBeNull();
  });
});
