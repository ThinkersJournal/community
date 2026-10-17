import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withClient } from "../src/db/client";
import { enqueueAndAttemptMove, processPendingMoves } from "../src/media/moves";

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

function randomKey(): string {
  return `media/post/${crypto.randomUUID().replace(/-/g, "").padEnd(64, "0")}.webp`;
}

async function moveRow(key: string): Promise<{ status: string; attempts: number } | null> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM media_moves WHERE r2_key = $1 ORDER BY created_at DESC LIMIT 1`,
      [key],
    );
    return rows[0] ?? null;
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("enqueueAndAttemptMove", () => {
  it("moves an object public -> restricted and marks the row done", async () => {
    const key = randomKey();
    await env.MEDIA.put(key, "bytes");

    const ctx = createExecutionContext();
    await enqueueAndAttemptMove(env, ctx, key, "to_restricted");
    await waitOnExecutionContext(ctx);

    expect(await env.MEDIA.head(key)).toBeNull();
    expect(await env.MEDIA_RESTRICTED.head(key)).not.toBeNull();
    expect(await moveRow(key)).toMatchObject({ status: "done" });
  });

  it("is idempotent when the object is already at the destination", async () => {
    const key = randomKey();
    // Never in the source bucket at all — as if a prior attempt already
    // finished the copy+delete but died before recording `done`.
    await env.MEDIA_RESTRICTED.put(key, "bytes");

    const ctx = createExecutionContext();
    await enqueueAndAttemptMove(env, ctx, key, "to_restricted");
    await waitOnExecutionContext(ctx);

    expect(await moveRow(key)).toMatchObject({ status: "done" });
  });
});

describe("a queued to_public move for a legally held key (#148)", () => {
  it("is cancelled, never republished: the held bytes stay in MEDIA_RESTRICTED and the row is closed", async () => {
    const key = randomKey();
    await env.MEDIA_RESTRICTED.put(key, "held bytes");
    // The ordering the issue describes: the to_public row was queued FIRST ...
    await ctxRun((c) => c.query(`INSERT INTO media_moves (r2_key, direction) VALUES ($1, 'to_public')`, [key]));
    // ... and the hold was imposed afterwards.
    await ctxRun((c) =>
      c.query(`INSERT INTO media_legal_holds (r2_key, imposed_by, category) VALUES ($1, 'mod@example.test', 'csam')`, [key]),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ctx = createExecutionContext();
      await processPendingMoves(env, ctx);
      await waitOnExecutionContext(ctx);

      // RED before the fix: the retry copied the bytes into the PUBLIC bucket.
      expect(await env.MEDIA.head(key)).toBeNull();
      expect(await env.MEDIA_RESTRICTED.head(key)).not.toBeNull();
      // RED before the fix: the row was marked done with no note.
      const row = await ctxRun(async (c) => {
        const { rows } = await c.query<{ status: string; last_error: string | null }>(
          `SELECT status, last_error FROM media_moves WHERE r2_key = $1`,
          [key],
        );
        return rows[0]!;
      });
      expect(row.status).toBe("done");
      expect(row.last_error).toMatch(/cancelled.*legal hold/);
      expect(warn.mock.calls.some((c) => JSON.stringify(c).includes(key))).toBe(true);
    } finally {
      warn.mockRestore();
      await ctxRun(async (c) => {
        await c.query(`DELETE FROM media_legal_holds WHERE r2_key = $1`, [key]);
        await c.query(`DELETE FROM media_moves WHERE r2_key = $1`, [key]);
      });
      await env.MEDIA_RESTRICTED.delete(key);
    }
  });

  it("control: the same queued to_public for an UNHELD key still moves", async () => {
    const key = randomKey();
    await env.MEDIA_RESTRICTED.put(key, "bytes");
    await ctxRun((c) => c.query(`INSERT INTO media_moves (r2_key, direction) VALUES ($1, 'to_public')`, [key]));
    const ctx = createExecutionContext();
    await processPendingMoves(env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.MEDIA.head(key)).not.toBeNull();
    expect(await moveRow(key)).toMatchObject({ status: "done" });
    await ctxRun((c) => c.query(`DELETE FROM media_moves WHERE r2_key = $1`, [key]));
    await env.MEDIA.delete(key);
  });
});

describe("processPendingMoves — retry and failure", () => {
  it("retries a pending row and eventually marks it failed, alerting loudly", async () => {
    const key = randomKey();
    await env.MEDIA.put(key, "bytes");

    // A MEDIA_RESTRICTED that always throws on put — every attempt fails.
    const brokenEnv = {
      ...env,
      MEDIA_RESTRICTED: {
        head: async () => null,
        put: async () => {
          throw new Error("simulated R2 failure");
        },
      },
    } as unknown as Env;

    const ctx = createExecutionContext();
    await enqueueAndAttemptMove(brokenEnv, ctx, key, "to_restricted");
    await waitOnExecutionContext(ctx);
    expect(await moveRow(key)).toMatchObject({ status: "pending", attempts: 1 });

    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 8; i++) {
      const ctx2 = createExecutionContext();
      await processPendingMoves(brokenEnv, ctx2);
      await waitOnExecutionContext(ctx2);
    }

    expect(await moveRow(key)).toMatchObject({ status: "failed" });
    expect(errorLog.mock.calls.some((c) => String(c[0]).includes("FAILED after"))).toBe(true);
  });
});
