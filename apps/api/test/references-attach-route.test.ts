// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

/**
 * POST /posts/:id/references (M3.4a): the route over `attachReference`. These cases are the ones that never reach the
 * network (the success path is pinned by references-attach.db.test.ts with a fake door). Each names the mutation that
 * must turn it red.
 */
const ORIGIN = "http://localhost:8787";
let author: Actor;
let other: Actor;
let postId: string;

async function call(actor: Actor | null, id: string, body: unknown, raw?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { Origin: ORIGIN, "content-type": "application/json" };
  if (actor !== null) {
    headers.Cookie = actor.cookie;
    headers["X-CSRF-Token"] = actor.csrfToken;
  }
  const res = await worker.fetch(
    new Request(`https://api.test/posts/${id}/references`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

beforeAll(async () => {
  author = await createVerifiedActor();
  other = await createVerifiedActor();
  postId = await createPublished(author);
});
afterAll(deleteCreatedUsers);

describe("POST /posts/:id/references", () => {
  it("401 without a session (mutation: drop runMutatingPipeline)", async () => {
    expect((await call(null, postId, { url: "https://example.com/a" })).status).toBe(401);
  });
  it("400 INVALID_JSON on a non-JSON body", async () => {
    const res = await call(author, postId, null, "not json");
    expect([res.status, await codeOf(res)]).toEqual([400, "INVALID_JSON"]);
  });
  it("400 INVALID_INPUT on a missing url (mutation: skip schema parse)", async () => {
    const res = await call(author, postId, { nope: 1 });
    expect([res.status, await codeOf(res)]).toEqual([400, "INVALID_INPUT"]);
  });
  it("400 INVALID_INPUT on a non-uuid post id (the DB would throw 22P02)", async () => {
    const res = await call(author, "not-a-uuid", { url: "https://example.com/a" });
    expect([res.status, await codeOf(res)]).toEqual([400, "INVALID_INPUT"]);
  });
  it("422 REFERENCE_FAILED reason=unsupported for a non-http scheme, with no fetch", async () => {
    const res = await call(author, postId, { url: "ftp://example.com/a" });
    const body = (await res.json()) as { code: string; reason: string };
    expect([res.status, body.code, body.reason]).toEqual([422, "REFERENCE_FAILED", "unsupported"]);
  });
  it.each(["http://169.254.169.254/latest", "http://127.0.0.1:8080/admin", "http://[::1]/"])(
    "422 blocked_target for a private address %s (the door refuses it before any network call)",
    async (url) => {
      const res = await call(author, postId, { url });
      const body = (await res.json()) as { code: string; reason: string };
      expect([res.status, body.code, body.reason]).toEqual([422, "REFERENCE_FAILED", "blocked_target"]);
    },
  );
  it("403 POST_UNDER_MODERATION while an auto-hide is pending review (#58: the reported version must not change)", async () => {
    const hiddenId = await createPublished(author);
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("UPDATE posts SET hidden_at = now() WHERE id = $1", [hiddenId]));
    await waitOnExecutionContext(ctx);
    // An unsupported URL would be 422 if the moderation gate were missing: the 403 proves the gate runs first.
    const res = await call(author, hiddenId, { url: "ftp://example.com/a" });
    expect([res.status, await codeOf(res)]).toEqual([403, "POST_UNDER_MODERATION"]);
  });
  it("404 NOT_FOUND for someone else's post (mutation: drop the author check)", async () => {
    const res = await call(other, postId, { url: "https://example.com/a" });
    expect([res.status, await codeOf(res)]).toEqual([404, "NOT_FOUND"]);
  });
});
