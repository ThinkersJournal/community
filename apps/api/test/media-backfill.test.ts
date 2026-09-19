import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withClient } from "../src/db/client";
import { backfillHiddenMedia, runOneBatch } from "../src/media/backfill-hidden-media";

/**
 * #61's one-off backfill (src/media/backfill-hidden-media.ts). The singleton
 * `media_backfill_progress` row is reset before each test — nothing else in
 * the shared test DB writes it, since every other suite exercises the LIVE
 * visibility hook directly (`applyMediaVisibilityChange`), never this sweep.
 */

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

function randomSha(): string {
  return crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
}
function keyFor(sha: string): string {
  return `media/post/${sha}.webp`;
}
function markdownWith(sha: string): string {
  return `![img](https://cdn.thinkersjournal.com/${keyFor(sha)})`;
}

async function resetProgress(): Promise<void> {
  await ctxRun((c) =>
    c.query(`UPDATE media_backfill_progress SET last_post_id = NULL, last_comment_id = NULL, completed_at = NULL WHERE id`),
  );
}

async function seedHiddenPostWithMedia(sha: string): Promise<string> {
  const userId = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, 'x', now()) RETURNING id`,
      [`test-${crypto.randomUUID()}@example.com`],
    );
    return rows[0]!.id;
  });
  return ctxRun(async (c) => {
    const slug = "test-" + crypto.randomUUID().slice(0, 8);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at, hidden_at)
       VALUES ($1, 'test', $2, $3, 'published', now(), now()) RETURNING id`,
      [userId, slug, markdownWith(sha)],
    );
    return rows[0]!.id;
  });
}

async function progressRow(): Promise<{ completed_at: Date | null }> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ completed_at: Date | null }>(`SELECT completed_at FROM media_backfill_progress WHERE id`);
    return rows[0]!;
  });
}

beforeEach(async () => {
  await resetProgress();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("backfill-hidden-media", () => {
  it("moves media for a post that was ALREADY hidden before this shipped", async () => {
    const sha = randomSha();
    await seedHiddenPostWithMedia(sha);
    await env.MEDIA.put(keyFor(sha), "bytes");

    const ctx = createExecutionContext();
    await runOneBatch(env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await env.MEDIA.head(keyFor(sha))).toBeNull();
    expect(await env.MEDIA_RESTRICTED.head(keyFor(sha))).not.toBeNull();
  });

  it("marks the singleton complete when a batch comes back under the page size", async () => {
    expect((await progressRow()).completed_at).toBeNull();
    const ctx = createExecutionContext();
    const result = await runOneBatch(env, ctx);
    await waitOnExecutionContext(ctx);

    expect(result.completed).toBe(true);
    expect((await progressRow()).completed_at).not.toBeNull();
  });

  it("is a cheap no-op once completed", async () => {
    const ctx1 = createExecutionContext();
    await runOneBatch(env, ctx1);
    await waitOnExecutionContext(ctx1);

    const ctx2 = createExecutionContext();
    const second = await runOneBatch(env, ctx2);
    await waitOnExecutionContext(ctx2);

    expect(second).toEqual({ posts: 0, comments: 0, completed: true });
  });

  it("backfillHiddenMedia (the admin-route path) drains every page and returns total counts", async () => {
    const sha = randomSha();
    await seedHiddenPostWithMedia(sha);
    await env.MEDIA.put(keyFor(sha), "bytes");

    const ctx = createExecutionContext();
    const result = await backfillHiddenMedia(env, ctx);
    await waitOnExecutionContext(ctx);

    expect(result.posts).toBeGreaterThanOrEqual(1);
    expect(await env.MEDIA_RESTRICTED.head(keyFor(sha))).not.toBeNull();
  });
});
