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
