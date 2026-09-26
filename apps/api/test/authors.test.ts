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

  /**
   * Enumeration fix (board item 59 follow-up). This directory is the
   * canonical index of every author on the site — a deleted account here is
   * discoverable with no post link at all, so it must be excluded, not just
   * tombstoned. Control (`author`) is seeded before this test's scrub, in the
   * SAME pass, so "excluded" is not indistinguishable from "the reaper broke".
   */
  it("excludes a scrubbed (anonymised) account", async () => {
    const scrubbed = await createVerifiedActor();
    await seedPost(scrubbed.userId, "published");

    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("UPDATE users SET anonymised_at = now() WHERE id = $1", [scrubbed.userId]),
    );
    await waitOnExecutionContext(ctx);

    const body = (await fetchWorker(new Request("https://api.test/public/authors")).then((r) => r.json())) as {
      authors: { username: string }[];
    };
    expect(body.authors.some((a) => a.username === scrubbed.username)).toBe(false);
    // CONTROL, same pass: an ordinary author is still present.
    expect(body.authors.some((a) => a.username === author.username)).toBe(true);
  });
});
