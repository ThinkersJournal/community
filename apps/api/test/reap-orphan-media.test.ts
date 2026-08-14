import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { reapOrphanMedia } from "../src/media/reap-orphan-media";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

/**
 * Task 4 (content-deletion + media-reclamation) — the daily orphan-media
 * reclaimer.
 *
 * Media has no FK to posts; the only link is the image URL embedded in a
 * post's `markdown_source` (see src/media/reap-orphan-media.ts's header).
 * `reapOrphanMedia` hard-deletes any `media` row whose sha256 appears in no
 * post's markdown and is older than the 24h grace window, and deletes the
 * underlying R2 object ONLY when no surviving row still holds its key
 * (content-addressed objects are shareable — see migrations/0002's note on
 * `media.r2_key`).
 *
 * Runs in the POOL project (real workerd) against the real Hyperdrive/Postgres
 * and R2 (`env.MEDIA`, `r2Buckets: ["MEDIA"]` in vitest.config.ts) bindings,
 * same shape as test/reap-unverified.test.ts.
 */

const ALLOWED_ORIGIN = "http://localhost:8787";

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

/** A fresh 64-char lowercase hex sha256-shaped string — the only thing the
 * reference-scan regex cares about the SHAPE of, not a real digest. */
function randomSha256Hex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every R2 key this suite has PUT, for `afterEach` cleanup regardless of
 * whether the reaper freed it — `.delete` on an already-gone key is a no-op. */
const createdKeys: string[] = [];

/** Seed a `media` row backdated `ageHours` old, plus its R2 object. */
async function seedMedia(
  ownerId: string,
  opts: { ageHours: number; sha256?: string },
): Promise<{ id: string; key: string; sha256: string }> {
  const sha256 = opts.sha256 ?? randomSha256Hex();
  const key = `media/post/${sha256}.webp`;
  await env.MEDIA.put(key, new Uint8Array([1, 2, 3]));
  createdKeys.push(key);
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO media (owner_id, r2_key, sha256, bytes, width, height, created_at)
       VALUES ($1,$2,$3,3,1,1, now() - ($4 || ' hours')::interval) RETURNING id`,
      [ownerId, key, sha256, String(opts.ageHours)],
    );
    return rows[0]!.id;
  });
  return { id, key, sha256 };
}

/** Insert a draft post whose markdown embeds the given text (e.g. a media URL). */
async function insertPost(authorId: string, markdown: string): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 't', $2, $3, 'draft', NULL) RETURNING id`,
      [authorId, `orphan-media-${crypto.randomUUID()}`, markdown],
    );
    return rows[0]!.id;
  });
}

async function mediaExists(id: string): Promise<boolean> {
  return ctxRun(async (c) => (await c.query(`SELECT 1 FROM media WHERE id = $1`, [id])).rowCount === 1);
}

/** Residue cleanup — the user cascade clears any surviving media/post rows
 * (both FK ON DELETE CASCADE to `users`); R2 objects do NOT cascade from a DB
 * delete, so they are cleared explicitly. */
afterEach(async () => {
  await deleteCreatedUsers();
  for (const key of createdKeys) {
    await env.MEDIA.delete(key);
  }
  createdKeys.length = 0;
});

describe("reapOrphanMedia", () => {
  it("reaps an unreferenced media row >24h old and deletes its R2 object", async () => {
    const actor = await createVerifiedActor();
    const { id, key } = await seedMedia(actor.userId, { ageHours: 25 });

    const ctx = createExecutionContext();
    const out = await reapOrphanMedia(env, ctx);
    await waitOnExecutionContext(ctx);

    // >=1, not ===1: the shared test DB may carry other suites' eligible rows
    // (see test/actor.ts's header / test/reap-unverified.test.ts's same note).
    // What this pins is that OUR fixture was reaped.
    expect(out.rows).toBeGreaterThanOrEqual(1);
    expect(await mediaExists(id)).toBe(false);
    expect(await env.MEDIA.get(key)).toBeNull();
  });

  it("keeps a media row whose sha256 appears in a post's markdown", async () => {
    const actor = await createVerifiedActor();
    const { id, key } = await seedMedia(actor.userId, { ageHours: 25 });
    await insertPost(actor.userId, `body ![](https://cdn.thinkersjournal.com/${key})`);

    const ctx = createExecutionContext();
    await reapOrphanMedia(env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await mediaExists(id)).toBe(true);
    expect(await env.MEDIA.get(key)).not.toBeNull();
  });

  it("keeps an unreferenced upload younger than 24h (grace)", async () => {
    const actor = await createVerifiedActor();
    const { id, key } = await seedMedia(actor.userId, { ageHours: 1 });

    const ctx = createExecutionContext();
    await reapOrphanMedia(env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await mediaExists(id)).toBe(true);
    expect(await env.MEDIA.get(key)).not.toBeNull();
  });

  it("DEDUP-SAFE: an object is kept while any media row still holds its key", async () => {
    // Two rows share one key/sha256 (content-addressed): one >24h (reaped),
    // one <24h (grace-kept). The reaped row's object must survive because the
    // sibling still references the key. (Two rows sharing a key share a
    // sha256, so they share referenced-status too — the dedup scenario worth
    // pinning is the GRACE sibling, not "one referenced one not", which is
    // impossible for rows on the same key.)
    const actor = await createVerifiedActor();
    const sha256 = randomSha256Hex();
    const old = await seedMedia(actor.userId, { sha256, ageHours: 25 }); // reaped
    const young = await seedMedia(actor.userId, { sha256, ageHours: 1 }); // same key, grace

    const ctx = createExecutionContext();
    await reapOrphanMedia(env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await mediaExists(old.id)).toBe(false);
    expect(await mediaExists(young.id)).toBe(true);
    expect(await env.MEDIA.get(old.key)).not.toBeNull(); // object kept — young still holds it
  });
});

describe("the scheduled dispatcher", () => {
  it('routes cron "15 4 * * *" to the orphan-media reclaimer', async () => {
    const actor = await createVerifiedActor();
    const { id, key } = await seedMedia(actor.userId, { ageHours: 25 });

    const ctx = createExecutionContext();
    await worker.scheduled(
      { cron: "15 4 * * *", scheduledTime: Date.now(), noRetry: () => {} },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Proof the reclaimer ran: the row seeded ONLY for this cron branch is gone.
    expect(await mediaExists(id)).toBe(false);
    expect(await env.MEDIA.get(key)).toBeNull();
  });
});

describe("POST /__test/reap-orphan-media", () => {
  it("invokes the reclaimer and reports { rows, objects }", async () => {
    const actor = await createVerifiedActor();
    const { id, key } = await seedMedia(actor.userId, { ageHours: 25 });

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/__test/reap-orphan-media", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: number; objects: number };
    expect(body.rows).toBeGreaterThanOrEqual(1);
    expect(body.objects).toBeGreaterThanOrEqual(1);
    expect(await mediaExists(id)).toBe(false);
    expect(await env.MEDIA.get(key)).toBeNull();
  });

  it("403s an origin-less request (same inline checkOrigin as the reaper's hook)", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/__test/reap-orphan-media", { method: "POST" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
  });

  it("404s when TEST_ROUTES is unset — same as a nonexistent route", async () => {
    const prodEnv = { ...env, TEST_ROUTES: undefined } as unknown as Env;

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/__test/reap-orphan-media", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN },
      }),
      prodEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
  });
});
