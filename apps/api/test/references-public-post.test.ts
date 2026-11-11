// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";
import type { PublicPost } from "@thinkersjournal/shared";

/**
 * M3.1b: `GET /public/posts` carries the post's reference cards (`refs`), read from Postgres only, and a hidden post
 * is a 404 so its cards cannot be reached through it (spec 4: "a post's removal or hide hides its cards").
 */
const ALLOWED_ORIGIN = "http://localhost:8787";
const TOKEN = "ABCDEFGHIJKL";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function create(actor: Actor, markdownSource: string): Promise<{ id: string; slug: string }> {
  const response = await fetchWorker(
    new Request("https://api.test/posts", {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ title: "Refs", markdownSource, status: "published" }),
    }),
  );
  if (response.status !== 201) throw new Error(`fixture create failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as { id: string; slug: string };
}

const referenceIds: string[] = [];

async function useReference(postId: string, token: string, snapshot: unknown): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO "references" (kind, resource_key, content_hash, snapshot) VALUES ('web', $1, $2, $3) RETURNING id`,
      [`web:https://example.com/${crypto.randomUUID()}`, crypto.randomUUID(), snapshot === null ? null : JSON.stringify(snapshot)],
    );
    referenceIds.push(rows[0]!.id);
    await c.query("INSERT INTO post_references (post_id, reference_id, token) VALUES ($1, $2, $3)", [postId, rows[0]!.id, token]);
  });
  await waitOnExecutionContext(ctx);
}

async function getPost(actor: Actor, slug: string): Promise<Response> {
  return fetchWorker(new Request(`https://api.test/public/posts?username=${actor.username}&slug=${slug}`));
}

let actor: Actor;
beforeAll(async () => {
  actor = await createVerifiedActor();
});
afterAll(async () => {
  await deleteCreatedUsers();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query(`DELETE FROM "references" WHERE id = ANY($1::uuid[])`, [referenceIds]));
  await waitOnExecutionContext(ctx);
});

describe("GET /public/posts: refs", () => {
  it("carries the cards of the post's tokens, keyed by token", async () => {
    const { id, slug } = await create(actor, `Intro\n\n{{ref:${TOKEN}}}\n`);
    await useReference(id, TOKEN, { kind: "web", title: "Card title", finalUrl: "https://example.com/p" });
    const post = (await (await getPost(actor, slug)).json()) as PublicPost;
    expect(post.refs?.[TOKEN]?.title).toBe("Card title");
  });

  it("a post with no references has no refs key at all (the response shape is unchanged)", async () => {
    const { slug } = await create(actor, "No refs here");
    const post = (await (await getPost(actor, slug)).json()) as PublicPost;
    expect("refs" in post).toBe(false);
  });

  it("a known token whose snapshot was removed is a null card, not a missing one", async () => {
    const { id, slug } = await create(actor, `{{ref:${TOKEN}}}`);
    await useReference(id, TOKEN, null);
    const post = (await (await getPost(actor, slug)).json()) as PublicPost;
    expect(post.refs).toEqual({ [TOKEN]: null });
  });

  // Mutation that must fail: drop `hidden_at IS NULL` from the public query (cards would be reachable through it).
  it("a hidden post is a 404, so its cards are not served", async () => {
    const { id, slug } = await create(actor, `{{ref:${TOKEN}}}`);
    await useReference(id, TOKEN, { kind: "web", title: "Secret card", finalUrl: "https://example.com/p" });
    expect((await getPost(actor, slug)).status).toBe(200); // control
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => c.query("UPDATE posts SET hidden_at = now() WHERE id = $1", [id]));
    await waitOnExecutionContext(ctx);
    const hidden = await getPost(actor, slug);
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain("Secret card");
  });
});
