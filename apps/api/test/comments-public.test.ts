import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { CommentsPage } from "@thinkersjournal/shared";
import type { Actor } from "./actor";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function onboardedActor(): Promise<Actor> {
  const actor = await createVerifiedActor();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE profiles SET username_chosen = true WHERE user_id = $1", [actor.userId]),
  );
  await waitOnExecutionContext(ctx);
  return actor;
}

async function insertPost(authorId: string, status: "draft" | "published"): Promise<string> {
  const ctx = createExecutionContext();
  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 't', $2, 'b', $3, CASE WHEN $3 = 'published' THEN now() ELSE NULL END)
       RETURNING id`,
      [authorId, `pc-${crypto.randomUUID()}`, status],
    );
    return rows[0]!.id;
  });
  await waitOnExecutionContext(ctx);
  return id;
}

/** Direct insert (read suite — the write route is Task 3's concern). */
async function insertComment(
  postId: string,
  authorId: string,
  parent?: { id: string; path: string; depth: number },
  deleted = false,
): Promise<{ id: string; path: string; depth: number }> {
  const depth = parent === undefined ? 0 : parent.depth + 1;
  const ctx = createExecutionContext();
  const row = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string; path: string }>(
      `WITH ids AS (SELECT uuidv7() AS id)
       INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown, deleted_at)
       SELECT ids.id, $1, $2, $3,
              CASE WHEN $4::text IS NULL THEN ids.id::text ELSE $4 || '/' || ids.id::text END,
              $5, $6, CASE WHEN $7 THEN now() ELSE NULL END
         FROM ids
       RETURNING id, path`,
      [postId, authorId, parent?.id ?? null, parent?.path ?? null, depth, deleted ? "" : "body", deleted],
    );
    return rows[0]!;
  });
  await waitOnExecutionContext(ctx);
  return { ...row, depth };
}

function getComments(postId: string, cursor?: string): Promise<Response> {
  const q = new URLSearchParams({ postId });
  if (cursor !== undefined) q.set("cursor", cursor);
  return fetchWorker(new Request(`https://api.test/public/comments?${q.toString()}`));
}

let author: Actor;
let postId: string;
beforeAll(async () => {
  author = await onboardedActor();
  postId = await insertPost(author.userId, "published");
});
afterAll(deleteCreatedUsers);

describe("GET /public/comments", () => {
  it("returns the tree in PATH order (thread order, siblings oldest-first)", async () => {
    const p = await insertPost(author.userId, "published");
    const a = await insertComment(p, author.userId);        // first top-level
    const a1 = await insertComment(p, author.userId, a);    // its reply
    const b = await insertComment(p, author.userId);        // second top-level
    const response = await getComments(p);
    expect(response.status).toBe(200);
    const page = (await response.json()) as CommentsPage;
    expect(page.comments.map((c) => c.id)).toEqual([a.id, a1.id, b.id]);
    expect(page.comments[1]).toMatchObject({ parentId: a.id, depth: 1, deleted: false });
    expect(page.comments[0]!.author).toMatchObject({ userId: author.userId });
    expect(page.nextCursor).toBeNull();
  });

  it("keyset-paginates on path: pages are disjoint, complete, and ordered", async () => {
    const p = await insertPost(author.userId, "published");
    const all: string[] = [];
    for (let i = 0; i < 51; i++) all.push((await insertComment(p, author.userId)).id);
    const page1 = (await (await getComments(p)).json()) as CommentsPage;
    expect(page1.comments).toHaveLength(50);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await (await getComments(p, page1.nextCursor!)).json()) as CommentsPage;
    expect(page2.comments).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect([...page1.comments, ...page2.comments].map((c) => c.id)).toEqual(all);
  });

  it("tombstones ship deleted:true, EMPTY body, NULL author", async () => {
    const p = await insertPost(author.userId, "published");
    await insertComment(p, author.userId, undefined, true);
    const page = (await (await getComments(p)).json()) as CommentsPage;
    expect(page.comments[0]).toMatchObject({ deleted: true, bodyMarkdown: "", author: null });
  });

  it("404s a draft post and a nonexistent post identically (parity)", async () => {
    const draft = await insertPost(author.userId, "draft");
    await insertComment(draft, author.userId);
    const onDraft = await getComments(draft);
    const onMissing = await getComments(crypto.randomUUID());
    expect(onDraft.status).toBe(404);
    expect(onMissing.status).toBe(404);
  });

  it("404s a missing/malformed postId", async () => {
    expect((await fetchWorker(new Request("https://api.test/public/comments"))).status).toBe(404);
    expect((await getComments("not-a-uuid")).status).toBe(404);
  });
});
