import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Seed a follow edge directly (bypasses the write path — this suite tests reads). */
async function seedFollow(followerId: string, followeeId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(
      "INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [followerId, followeeId],
    ),
  );
  await waitOnExecutionContext(ctx);
}

let star: Actor;   // followed by many
let fan: Actor;    // follows star
beforeAll(async () => {
  star = await createVerifiedActor();
  fan = await createVerifiedActor();
  await seedFollow(fan.userId, star.userId);
});
afterAll(async () => { await deleteCreatedUsers(); });

describe("GET /public/social", () => {
  it("returns viewer-independent counts", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/public/social?username=${star.username}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { followersCount: number; followingCount: number };
    expect(body.followersCount).toBeGreaterThanOrEqual(1);
    expect(body.followingCount).toBe(0);
  });

  it("404s for an unknown username", async () => {
    const response = await fetchWorker(new Request("https://api.test/public/social?username=nobody_xyz"));
    expect(response.status).toBe(404);
  });
});

describe("GET /public/followers", () => {
  it("lists the followers of a user (keyset)", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/public/followers?username=${star.username}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: { username: string }[]; nextCursor: string | null };
    expect(body.users.some((u) => u.username === fan.username)).toBe(true);
  });

  it("400s on a malformed cursor", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/public/followers?username=${star.username}&cursor=not-a-uuid`),
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /public/following", () => {
  it("lists who a user follows", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/public/following?username=${fan.username}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: { username: string }[] };
    expect(body.users.some((u) => u.username === star.username)).toBe(true);
  });
});

describe("GET /follows/status", () => {
  it("returns the subset of ids the viewer follows", async () => {
    const other = await createVerifiedActor();
    const response = await fetchWorker(
      new Request(`https://api.test/follows/status?id=${star.userId}&id=${other.userId}`, {
        headers: { Cookie: fan.cookie },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { following: string[]; viewerId: string };
    expect(body.following).toContain(star.userId);
    expect(body.following).not.toContain(other.userId);
    expect(body.viewerId).toBe(fan.userId);
  });

  it("401s without a session", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/follows/status?id=${star.userId}`),
    );
    expect(response.status).toBe(401);
  });
});
