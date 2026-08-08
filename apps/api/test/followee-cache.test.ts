import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  bustFolloweeCache,
  followeeKey,
  readFolloweeCache,
  writeFolloweeCache,
} from "../src/social/followee-cache";

describe("followee-cache (KV)", () => {
  it("round-trips a list: write then read returns the same ids", async () => {
    const userId = crypto.randomUUID();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    await writeFolloweeCache(env, userId, ids);
    expect(await readFolloweeCache(env, userId)).toEqual(ids);
  });

  it("returns null (a MISS) for an unwritten key", async () => {
    expect(await readFolloweeCache(env, crypto.randomUUID())).toBeNull();
  });

  it("caches an empty list as a HIT ([]), distinct from a miss (null)", async () => {
    const userId = crypto.randomUUID();
    await writeFolloweeCache(env, userId, []);
    expect(await readFolloweeCache(env, userId)).toEqual([]); // NOT null
  });

  it("bust deletes the key: a written entry reads null afterward", async () => {
    const userId = crypto.randomUUID();
    await writeFolloweeCache(env, userId, [crypto.randomUUID()]);
    await bustFolloweeCache(env, userId);
    expect(await readFolloweeCache(env, userId)).toBeNull();
  });

  it("stores JSON under the followees:<userId> key", async () => {
    const userId = crypto.randomUUID();
    await writeFolloweeCache(env, userId, ["x"]);
    expect(await env.FOLLOWEES.get(followeeKey(userId))).toBe(JSON.stringify(["x"]));
  });

  it("fails open: a KV whose get throws is a miss (null), not an error", async () => {
    const throwingEnv = {
      ...env,
      FOLLOWEES: { get: () => { throw new Error("KV down"); } },
    } as unknown as Env;
    expect(await readFolloweeCache(throwingEnv, crypto.randomUUID())).toBeNull();
  });

  it("fails open on malformed JSON (treats a corrupt value as a miss)", async () => {
    const userId = crypto.randomUUID();
    await env.FOLLOWEES.put(followeeKey(userId), "not json{");
    expect(await readFolloweeCache(env, userId)).toBeNull();
  });

  it("fails open: a KV whose put throws does not reject (a lost write is swallowed)", async () => {
    const throwingEnv = {
      ...env,
      FOLLOWEES: { put: () => { throw new Error("KV down"); } },
    } as unknown as Env;
    await expect(writeFolloweeCache(throwingEnv, crypto.randomUUID(), [])).resolves.toBeUndefined();
  });

  it("fails open: a KV whose delete throws does not reject (a lost bust is swallowed)", async () => {
    const throwingEnv = {
      ...env,
      FOLLOWEES: { delete: () => { throw new Error("KV down"); } },
    } as unknown as Env;
    await expect(bustFolloweeCache(throwingEnv, crypto.randomUUID())).resolves.toBeUndefined();
  });
});
