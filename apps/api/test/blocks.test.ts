import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function block(actor: Actor, blockedId: string): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/blocks", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ blockedId }),
    }),
  );
}

function unblock(actor: Actor, blockedId: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/blocks/${blockedId}`, {
      method: "DELETE",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
      },
    }),
  );
}

async function blockRowCount(blockerId: string, blockedId: string): Promise<number> {
  const ctx = createExecutionContext();
  const n = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      "SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2",
      [blockerId, blockedId],
    );
    return rows.length;
  });
  await waitOnExecutionContext(ctx);
  return n;
}

async function followEdgeExists(followerId: string, followeeId: string): Promise<boolean> {
  const ctx = createExecutionContext();
  const exists = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      "SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2",
      [followerId, followeeId],
    );
    return rows.length > 0;
  });
  await waitOnExecutionContext(ctx);
  return exists;
}

async function insertFollow(followerId: string, followeeId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(
      "INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [followerId, followeeId],
    ),
  );
  await waitOnExecutionContext(ctx);
}

let alice: Actor;
let bob: Actor;
beforeAll(async () => {
  alice = await createVerifiedActor();
  bob = await createVerifiedActor();
});
afterAll(async () => {
  await deleteCreatedUsers();
});

describe("POST /blocks", () => {
  it("creates the block row and 201s", async () => {
    const blocker = await createVerifiedActor();
    const blocked = await createVerifiedActor();
    const response = await block(blocker, blocked.userId);
    expect(response.status).toBe(201);
    expect(await blockRowCount(blocker.userId, blocked.userId)).toBe(1);
  });

  it("400s CANNOT_BLOCK_SELF", async () => {
    const response = await block(alice, alice.userId);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("CANNOT_BLOCK_SELF");
  });

  it("is idempotent for a repeat block (still one row)", async () => {
    const blocker = await createVerifiedActor();
    const blocked = await createVerifiedActor();
    const r1 = await block(blocker, blocked.userId);
    expect(r1.status).toBe(201);
    const r2 = await block(blocker, blocked.userId);
    expect(r2.status).toBe(201);
    expect(await blockRowCount(blocker.userId, blocked.userId)).toBe(1);
  });

  it("404s for a nonexistent user", async () => {
    const response = await block(alice, crypto.randomUUID());
    expect(response.status).toBe(404);
  });

  it("deletes a pre-existing follow edge in EITHER direction on block", async () => {
    const blocker = await createVerifiedActor();
    const blocked = await createVerifiedActor();
    // Seed both directions.
    await insertFollow(blocker.userId, blocked.userId);
    await insertFollow(blocked.userId, blocker.userId);
    expect(await followEdgeExists(blocker.userId, blocked.userId)).toBe(true);
    expect(await followEdgeExists(blocked.userId, blocker.userId)).toBe(true);

    const response = await block(blocker, blocked.userId);
    expect(response.status).toBe(201);

    expect(await followEdgeExists(blocker.userId, blocked.userId)).toBe(false);
    expect(await followEdgeExists(blocked.userId, blocker.userId)).toBe(false);
  });

  it("busts the followee cache for BOTH the blocker and the blocked user", async () => {
    const blocker = await createVerifiedActor();
    const blocked = await createVerifiedActor();
    const busted: string[] = [];
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/blocks", {
        method: "POST",
        headers: {
          Origin: ALLOWED_ORIGIN,
          Cookie: blocker.cookie,
          "X-CSRF-Token": blocker.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ blockedId: blocked.userId }),
      }),
      {
        ...env,
        FOLLOWEES: {
          ...env.FOLLOWEES,
          delete: async (key: string) => {
            busted.push(key);
            return env.FOLLOWEES.delete(key);
          },
        },
      } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    expect(busted.sort()).toEqual(
      [`followees:${blocker.userId}`, `followees:${blocked.userId}`].sort(),
    );
  });
});

describe("DELETE /blocks/:blockedId", () => {
  it("removes the row and 204s", async () => {
    const blocker = await createVerifiedActor();
    const blocked = await createVerifiedActor();
    await block(blocker, blocked.userId);
    const response = await unblock(blocker, blocked.userId);
    expect(response.status).toBe(204);
    expect(await blockRowCount(blocker.userId, blocked.userId)).toBe(0);
  });

  it("404s NOT_BLOCKED for a pair that is not blocked", async () => {
    const response = await unblock(alice, bob.userId);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("NOT_BLOCKED");
  });

  it("busts the followee cache for BOTH users on unblock", async () => {
    const blocker = await createVerifiedActor();
    const blocked = await createVerifiedActor();
    await block(blocker, blocked.userId);

    const busted: string[] = [];
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://api.test/blocks/${blocked.userId}`, {
        method: "DELETE",
        headers: {
          Origin: ALLOWED_ORIGIN,
          Cookie: blocker.cookie,
          "X-CSRF-Token": blocker.csrfToken,
        },
      }),
      {
        ...env,
        FOLLOWEES: {
          ...env.FOLLOWEES,
          delete: async (key: string) => {
            busted.push(key);
            return env.FOLLOWEES.delete(key);
          },
        },
      } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(204);
    expect(busted.sort()).toEqual(
      [`followees:${blocker.userId}`, `followees:${blocked.userId}`].sort(),
    );
  });
});
