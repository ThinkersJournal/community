import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedPost(authorId: string, status: "draft" | "published"): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1,'t',$2,'b',$3, CASE WHEN $3='published' THEN now() ELSE NULL END)`,
      [authorId, `s-${crypto.randomUUID()}`, status],
    ),
  );
  await waitOnExecutionContext(ctx);
}

let author: Actor;
let draftOnly: Actor;
beforeAll(async () => {
  author = await createVerifiedActor();
  draftOnly = await createVerifiedActor();
  await seedPost(author.userId, "published");
  await seedPost(draftOnly.userId, "draft");
});
afterAll(async () => { await deleteCreatedUsers(); });

describe("GET /public/authors", () => {
  it("lists an author with a published post", async () => {
    const response = await fetchWorker(new Request("https://api.test/public/authors"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authors: { username: string; userId: string; latestPostId: string }[] };
    expect(body.authors.some((a) => a.username === author.username)).toBe(true);
    expect(body.authors.every((a) => typeof a.latestPostId === "string")).toBe(true);
  });

  it("excludes an author with only drafts", async () => {
    const body = (await fetchWorker(new Request("https://api.test/public/authors")).then((r) => r.json())) as {
      authors: { username: string }[];
    };
    expect(body.authors.some((a) => a.username === draftOnly.username)).toBe(false);
  });

  it("400s on a malformed cursor", async () => {
    const response = await fetchWorker(new Request("https://api.test/public/authors?cursor=not-a-uuid"));
    expect(response.status).toBe(400);
  });
});
