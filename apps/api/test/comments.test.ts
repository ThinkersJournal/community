import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createUnverifiedActor, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Verified + handle chosen (mirrors follows.test.ts). */
async function onboardedActor(): Promise<Actor> {
  const actor = await createVerifiedActor();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE profiles SET username_chosen = true WHERE user_id = $1", [actor.userId]),
  );
  await waitOnExecutionContext(ctx);
  return actor;
}

function mutatingHeaders(actor: Actor): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    Cookie: actor.cookie,
    "X-CSRF-Token": actor.csrfToken,
    "content-type": "application/json",
  };
}

/** Insert a post row directly (status parameterized) and return its id. */
async function insertPost(authorId: string, status: "draft" | "published"): Promise<string> {
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 't', $2, 'b', $3, CASE WHEN $3 = 'published' THEN now() ELSE NULL END)
       RETURNING id`,
      [authorId, `c-${crypto.randomUUID()}`, status],
    );
    return rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return id;
}

function createComment(
  actor: Actor,
  body: { postId: string; parentId?: string; markdownSource: string },
): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/comments", {
      method: "POST",
      headers: mutatingHeaders(actor),
      body: JSON.stringify(body),
    }),
  );
}

async function commentRow(id: string): Promise<{ path: string; depth: number } | null> {
  const ctx = createExecutionContext();
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ path: string; depth: number }>(
      "SELECT path, depth FROM comments WHERE id = $1",
      [id],
    );
    return rows[0] ?? null;
  });
  await waitOnExecutionContext(ctx);
  return row;
}

let author: Actor;
let reader: Actor;
let postId: string;
beforeAll(async () => {
  author = await onboardedActor();
  reader = await onboardedActor();
  postId = await insertPost(author.userId, "published");
});
afterAll(deleteCreatedUsers);

describe("POST /comments", () => {
  it("creates a top-level comment (depth 0, path = own id) and 201s", async () => {
    const response = await createComment(reader, { postId, markdownSource: "first!" });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const row = await commentRow(id);
    expect(row).toEqual({ path: id, depth: 0 });
  });

  it("creates a nested reply (depth+1, path = parent/child)", async () => {
    const top = await createComment(reader, { postId, markdownSource: "top" });
    const { id: parentId } = (await top.json()) as { id: string };
    const reply = await createComment(author, { postId, parentId, markdownSource: "re" });
    expect(reply.status).toBe(201);
    const { id } = (await reply.json()) as { id: string };
    expect(await commentRow(id)).toEqual({ path: `${parentId}/${id}`, depth: 1 });
  });

  it("404s a DRAFT post exactly like a nonexistent one (parity)", async () => {
    const draftId = await insertPost(author.userId, "draft");
    const onDraft = await createComment(reader, { postId: draftId, markdownSource: "x" });
    const onMissing = await createComment(reader, {
      postId: crypto.randomUUID(),
      markdownSource: "x",
    });
    expect(onDraft.status).toBe(404);
    expect(onMissing.status).toBe(404);
    expect(((await onDraft.json()) as { code: string }).code).toBe(
      ((await onMissing.json()) as { code: string }).code,
    );
  });

  it("404s COMMENT_NOT_FOUND for a parent from a DIFFERENT post", async () => {
    const otherPost = await insertPost(author.userId, "published");
    const other = await createComment(reader, { postId: otherPost, markdownSource: "elsewhere" });
    const { id: foreignParent } = (await other.json()) as { id: string };
    const response = await createComment(reader, {
      postId,
      parentId: foreignParent,
      markdownSource: "x",
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("COMMENT_NOT_FOUND");
  });

  it("409s COMMENT_DELETED replying to a tombstone", async () => {
    const top = await createComment(reader, { postId, markdownSource: "doomed" });
    const { id: parentId } = (await top.json()) as { id: string };
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("UPDATE comments SET deleted_at = now(), body_markdown = '' WHERE id = $1", [parentId]),
    );
    await waitOnExecutionContext(ctx);
    const response = await createComment(reader, { postId, parentId, markdownSource: "x" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("COMMENT_DELETED");
  });

  it("409s COMMENT_DEPTH_EXCEEDED replying at the cap", async () => {
    // Own onboardedActor: this case alone makes 10 comment writes, and
    // COMMENT_LIMITER is 10/60s — sharing `reader`'s budget with the rest of
    // this suite would flake it.
    const depthActor = await onboardedActor();
    let parentId: string | undefined;
    for (let d = 0; d <= 8; d++) {
      const r = await createComment(depthActor, { postId, parentId, markdownSource: `d${d}` });
      expect(r.status).toBe(201);
      parentId = ((await r.json()) as { id: string }).id;
    }
    const over = await createComment(depthActor, { postId, parentId, markdownSource: "d9" });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { code: string }).code).toBe("COMMENT_DEPTH_EXCEEDED");
  });

  it("403s EMAIL_NOT_VERIFIED for an unverified commenter", async () => {
    const unverified = await createUnverifiedActor();
    const response = await createComment(unverified, { postId, markdownSource: "x" });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("409s USERNAME_REQUIRED for a verified commenter with no handle", async () => {
    const noHandle = await createVerifiedActor();
    const response = await createComment(noHandle, { postId, markdownSource: "x" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("USERNAME_REQUIRED");
  });

  it("400s INVALID_INPUT for an empty body and an over-cap body", async () => {
    const empty = await createComment(reader, { postId, markdownSource: "" });
    expect(empty.status).toBe(400);
    const over = await createComment(reader, { postId, markdownSource: "a".repeat(10_001) });
    expect(over.status).toBe(400);
  });
});
