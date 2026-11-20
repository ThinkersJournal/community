// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { applyDecision } from "../src/moderation/decide";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Client } from "pg";
import type { Actor } from "./actor";

/**
 * M3.10 slice B: a moderator REMOVE copies the post's reference-card snapshots into `moderation_snapshots.card_snapshots`
 * (migration 0044) in the same transaction as the ruling, exactly as the author-delete path does (routes/posts.ts
 * handleDeletePost; both use references/card-snapshots.ts). The evidence is then independent of the shared
 * `"references"` row, and no card text is served publicly.
 *
 * ⚠️ Snapshot rows cannot be deleted inside their first year (0021's guard), so these tests leave rows behind by design.
 * They are keyed by this run's random post ids and reference nothing.
 */
const ALLOWED_ORIGIN = "http://localhost:8787";
const TOKEN = "ABCDEFGHIJKL";
const CARD_TITLE = "Evidence card title";
const ADMIN = "mod-snapshot-test@example.test";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function run<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const value = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return value;
}

const referenceIds: string[] = [];
let actor: Actor;

beforeAll(async () => {
  actor = await createVerifiedActor();
});

afterAll(async () => {
  await run(async (c) => {
    await c.query(
      `DELETE FROM moderation_notice_outbox
        WHERE action_id IN (SELECT id FROM moderation_actions WHERE subject_user_id = $1)`,
      [actor.userId],
    );
  });
  await deleteCreatedUsers();
  await run((c) => c.query(`DELETE FROM "references" WHERE id = ANY($1::uuid[])`, [referenceIds]));
});

async function createPost(withCard: boolean): Promise<{ id: string; slug: string; referenceId: string | null }> {
  const response = await fetchWorker(
    new Request("https://api.test/posts", {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ title: "Evidence", markdownSource: withCard ? `Intro\n\n{{ref:${TOKEN}}}\n` : "Intro only", status: "published" }),
    }),
  );
  if (response.status !== 201) throw new Error(`fixture create failed: ${response.status} ${await response.text()}`);
  const post = (await response.json()) as { id: string; slug: string };
  let referenceId: string | null = null;
  if (withCard) {
    referenceId = await run(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO "references" (kind, resource_key, content_hash, snapshot) VALUES ('web', $1, $2, $3) RETURNING id`,
        [
          `web:https://example.com/${crypto.randomUUID()}`,
          "hash-evidence",
          JSON.stringify({ kind: "web", title: CARD_TITLE, finalUrl: "https://example.com/p" }),
        ],
      );
      await c.query("INSERT INTO post_references (post_id, reference_id, token) VALUES ($1, $2, $3)", [post.id, rows[0]!.id, TOKEN]);
      return rows[0]!.id;
    });
    referenceIds.push(referenceId);
  }
  return { ...post, referenceId };
}

interface SnapshotRow {
  author_id: string;
  title: string | null;
  body_markdown: string;
  card_snapshots: Array<{
    token: string; kind: string; resource_key: string; content_hash: string; position: number;
    snapshot: { title?: string } | null;
  }> | null;
}

function snapshotsFor(postId: string): Promise<SnapshotRow[]> {
  return run(async (c) =>
    (await c.query<SnapshotRow>(
      `SELECT author_id, title, body_markdown, card_snapshots FROM moderation_snapshots WHERE post_id = $1`,
      [postId],
    )).rows,
  );
}

function decide(postId: string, decision: "remove" | "keep_hidden") {
  return run((c) => applyDecision(c, { subject: "post", subjectId: postId, decision, reason: "test ruling", actorAdmin: ADMIN }));
}

describe("moderator remove stores the cards as evidence", () => {
  it("copies the post and its card snapshots into moderation_snapshots, and serves nothing publicly", async () => {
    const post = await createPost(true);
    expect(await snapshotsFor(post.id)).toHaveLength(0); // control: nothing before the ruling

    await decide(post.id, "remove");

    const rows = await snapshotsFor(post.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.author_id).toBe(actor.userId);
    expect(rows[0]!.title).toBe("Evidence");
    expect(rows[0]!.body_markdown).toContain(`{{ref:${TOKEN}}}`);
    const cards = rows[0]!.card_snapshots;
    expect(cards).toHaveLength(1);
    expect(cards![0]).toMatchObject({ token: TOKEN, kind: "web", content_hash: "hash-evidence", position: expect.any(Number) });
    expect(cards![0]!.snapshot?.title).toBe(CARD_TITLE);

    const publicRead = await fetchWorker(new Request(`https://api.test/public/posts?username=${actor.username}&slug=${post.slug}`));
    expect(publicRead.status).toBe(404);
    expect(await publicRead.text()).not.toContain(CARD_TITLE);
  });

  it("the evidence survives the shared reference losing its snapshot", async () => {
    const post = await createPost(true);
    await decide(post.id, "remove");
    await run((c) => c.query(`UPDATE "references" SET snapshot = NULL WHERE id = $1`, [post.referenceId]));
    const rows = await snapshotsFor(post.id);
    expect(rows[0]!.card_snapshots![0]!.snapshot?.title).toBe(CARD_TITLE);
  });

  it("a post with no cards still gets its snapshot, with card_snapshots NULL", async () => {
    const post = await createPost(false);
    await decide(post.id, "remove");
    const rows = await snapshotsFor(post.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.card_snapshots).toBeNull();
  });

  it("CONTROL: keep_hidden (not a removal) writes no snapshot", async () => {
    const post = await createPost(true);
    await decide(post.id, "keep_hidden");
    expect(await snapshotsFor(post.id)).toHaveLength(0);
  });
});
