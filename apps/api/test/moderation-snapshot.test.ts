import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

/**
 * #58 Q1, option B. CireSnave: "allow the author to delete the post which would
 * hide it from all users. However, keep the content of it somewhere for legal
 * use."
 *
 * The delete still succeeds and still removes the content from the live
 * Service. What changes is that content UNDER MODERATION at that moment leaves
 * a `moderation_snapshots` row behind. Content that is not under moderation
 * leaves nothing — those arms are the controls that prove the snapshot is
 * caused by moderation, not by deletion in general.
 *
 * "Under moderation" is #58's edit-freeze definition: for a post,
 * src/moderation/author-hide.ts's POST_NOT_UNDER_MODERATION_SQL, negated; for a
 * comment, `hidden_at IS NOT NULL` (comments have no author self-hide).
 */

const ALLOWED_ORIGIN = "http://localhost:8787";

afterEach(async () => {
  await deleteCreatedUsers();
});

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => (await c.query<T>(text, params)).rows);
  await waitOnExecutionContext(ctx);
  return rows;
}

function mutating(actor: Actor, method: string, path: string, body?: unknown): Request {
  return new Request(`https://api.test${path}`, {
    method,
    headers: {
      Origin: ALLOWED_ORIGIN,
      Cookie: actor.cookie,
      "X-CSRF-Token": actor.csrfToken,
      "content-type": "application/json",
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function postSnapshots(postId: string) {
  return sql<{ author_id: string; title: string | null; body_markdown: string }>(
    `SELECT author_id, title, body_markdown FROM moderation_snapshots WHERE post_id = $1`,
    [postId],
  );
}

async function commentSnapshots(commentId: string) {
  return sql<{ author_id: string; title: string | null; body_markdown: string }>(
    `SELECT author_id, title, body_markdown FROM moderation_snapshots WHERE comment_id = $1`,
    [commentId],
  );
}

async function postSource(postId: string): Promise<{ title: string; markdown_source: string }> {
  const rows = await sql<{ title: string; markdown_source: string }>(
    `SELECT title, markdown_source FROM posts WHERE id = $1`,
    [postId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function postExists(postId: string): Promise<boolean> {
  return (await sql(`SELECT 1 FROM posts WHERE id = $1`, [postId])).length === 1;
}

async function autoHide(postId: string): Promise<void> {
  await sql(`UPDATE posts SET hidden_at = now() WHERE id = $1`, [postId]);
}

async function seedComment(commenter: Actor, postId: string, markdownSource: string): Promise<string> {
  const response = await fetchWorker(mutating(commenter, "POST", "/comments", { postId, markdownSource }));
  if (response.status !== 201) throw new Error(`fixture comment failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { id: string }).id;
}

describe("#58 — author DELETE /posts/:id under moderation keeps a snapshot", () => {
  it("an AUTO-HIDDEN post: the delete succeeds, the post is gone, and a snapshot holds its title and source", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const before = await postSource(postId);
    await autoHide(postId);

    const res = await fetchWorker(mutating(author, "DELETE", `/posts/${postId}`));

    expect(res.status).toBe(200);
    expect(await postExists(postId)).toBe(false);
    expect(await postSnapshots(postId)).toEqual([
      { author_id: author.userId, title: before.title, body_markdown: before.markdown_source },
    ]);
  });

  it("a MODERATOR-REMOVED post (content_remove on the log) is snapshotted too", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await autoHide(postId);
    await sql(
      `INSERT INTO moderation_actions (actor_admin, action, post_id, reason) VALUES ('mod@example.test', 'content_remove', $1, 'r')`,
      [postId],
    );

    expect((await fetchWorker(mutating(author, "DELETE", `/posts/${postId}`))).status).toBe(200);
    expect(await postSnapshots(postId)).toHaveLength(1);
  });

  it("CONTROL: a VISIBLE post leaves no snapshot", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);

    expect((await fetchWorker(mutating(author, "DELETE", `/posts/${postId}`))).status).toBe(200);
    expect(await postExists(postId)).toBe(false);
    expect(await postSnapshots(postId)).toEqual([]);
  });

  it("CONTROL: a post hidden by its OWN AUTHOR (not moderation) leaves no snapshot", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    expect((await fetchWorker(mutating(author, "POST", `/posts/${postId}/hide`))).status).toBe(200);

    expect((await fetchWorker(mutating(author, "DELETE", `/posts/${postId}`))).status).toBe(200);
    expect(await postSnapshots(postId)).toEqual([]);
  });

  it("a STRANGER deleting someone else's hidden post: 404, the post stays, and no snapshot is written", async () => {
    const author = await createVerifiedActor();
    const stranger = await createVerifiedActor();
    const postId = await createPublished(author);
    await autoHide(postId);

    expect((await fetchWorker(mutating(stranger, "DELETE", `/posts/${postId}`))).status).toBe(404);
    expect(await postExists(postId)).toBe(true);
    expect(await postSnapshots(postId)).toEqual([]);
  });
});

describe("#58 — DELETE /comments/:id under moderation keeps a snapshot", () => {
  it("a HIDDEN comment deleted by its author: tombstoned live, original body kept in the snapshot", async () => {
    const postAuthor = await createVerifiedActor();
    const commenter = await createVerifiedActor();
    const postId = await createPublished(postAuthor);
    const commentId = await seedComment(commenter, postId, "the reported words");
    await sql(`UPDATE comments SET hidden_at = now() WHERE id = $1`, [commentId]);

    expect((await fetchWorker(mutating(commenter, "DELETE", `/comments/${commentId}`))).status).toBe(200);

    const live = await sql<{ body_markdown: string; deleted: boolean }>(
      `SELECT body_markdown, deleted_at IS NOT NULL AS deleted FROM comments WHERE id = $1`,
      [commentId],
    );
    expect(live).toEqual([{ body_markdown: "", deleted: true }]);
    expect(await commentSnapshots(commentId)).toEqual([
      { author_id: commenter.userId, title: null, body_markdown: "the reported words" },
    ]);
  });

  it("a hidden comment deleted by the POST's author is snapshotted under the COMMENTER's id", async () => {
    const postAuthor = await createVerifiedActor();
    const commenter = await createVerifiedActor();
    const postId = await createPublished(postAuthor);
    const commentId = await seedComment(commenter, postId, "on someone else's post");
    await sql(`UPDATE comments SET hidden_at = now() WHERE id = $1`, [commentId]);

    expect((await fetchWorker(mutating(postAuthor, "DELETE", `/comments/${commentId}`))).status).toBe(200);
    expect((await commentSnapshots(commentId)).map((s) => s.author_id)).toEqual([commenter.userId]);
  });

  it("CONTROL: a VISIBLE comment leaves no snapshot", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const commentId = await seedComment(author, postId, "fine words");

    expect((await fetchWorker(mutating(author, "DELETE", `/comments/${commentId}`))).status).toBe(200);
    expect(await commentSnapshots(commentId)).toEqual([]);
  });

  it("a repeat delete of an already-tombstoned hidden comment does not snapshot again (or snapshot the blanked body)", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const commentId = await seedComment(author, postId, "said once");
    await sql(`UPDATE comments SET hidden_at = now() WHERE id = $1`, [commentId]);

    expect((await fetchWorker(mutating(author, "DELETE", `/comments/${commentId}`))).status).toBe(200);
    expect((await fetchWorker(mutating(author, "DELETE", `/comments/${commentId}`))).status).toBe(200);
    expect((await commentSnapshots(commentId)).map((s) => s.body_markdown)).toEqual(["said once"]);
  });
});
