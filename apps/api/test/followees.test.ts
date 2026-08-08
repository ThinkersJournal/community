import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import { followeeKey } from "../src/social/followee-cache";
import { getFolloweeIds } from "../src/social/followees";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

afterAll(async () => { await deleteCreatedUsers(); });

async function call(userId: string): Promise<string[]> {
  const ctx = createExecutionContext();
  const ids = await getFolloweeIds(env, ctx, userId);
  await waitOnExecutionContext(ctx);
  return ids;
}

describe("getFolloweeIds (cache-aside)", () => {
  it("MISS: reads the follow graph from Postgres and populates the cache", async () => {
    const viewer = await createVerifiedActor();
    const followed = await createVerifiedActor();
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2)", [
        viewer.userId, followed.userId,
      ]),
    );
    await waitOnExecutionContext(ctx);

    expect(await env.FOLLOWEES.get(followeeKey(viewer.userId))).toBeNull(); // cold
    expect(await call(viewer.userId)).toEqual([followed.userId]);           // served from PG
    expect(await env.FOLLOWEES.get(followeeKey(viewer.userId)))             // now populated
      .toBe(JSON.stringify([followed.userId]));
  });

  it("HIT: returns the cached list WITHOUT touching Postgres (cache wins over DB truth)", async () => {
    const viewer = await createVerifiedActor();
    // A phantom id that is NOT in the follows table. If the read hit Postgres it
    // would return [] (no edges); returning the phantom proves KV alone served it.
    const phantom = crypto.randomUUID();
    await env.FOLLOWEES.put(followeeKey(viewer.userId), JSON.stringify([phantom]));
    expect(await call(viewer.userId)).toEqual([phantom]);
  });

  it("zero-follow viewer: MISS returns [] and caches [] as a hit", async () => {
    const lonely = await createVerifiedActor();
    expect(await call(lonely.userId)).toEqual([]);
    expect(await env.FOLLOWEES.get(followeeKey(lonely.userId))).toBe(JSON.stringify([]));
  });
});
