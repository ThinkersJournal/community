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

  /**
   * Enumeration fix (board item 59 follow-up). `userIdForUsername` — shared
   * by this route and both listing routes below — must decline an anonymised
   * handle exactly like an unknown one, so "who follows @deleted-user-<id>"
   * 404s the same way an unknown username does.
   */
  it("404s for a scrubbed (anonymised) account's handle", async () => {
    const scrubbed = await createVerifiedActor();
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("UPDATE users SET anonymised_at = now() WHERE id = $1", [scrubbed.userId]),
    );
    await waitOnExecutionContext(ctx);

    const response = await fetchWorker(
      new Request(`https://api.test/public/social?username=${scrubbed.username}`),
    );
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

  /**
   * Enumeration fix (board item 59 follow-up). The follows edge is RETAINED
   * (keep-the-graph ruling) — only its display here is filtered. Control
   * (`fan`) proves the list itself still works, in the same request.
   */
  it("omits a scrubbed (anonymised) follower while keeping an ordinary one", async () => {
    const scrubbedFan = await createVerifiedActor();
    await seedFollow(scrubbedFan.userId, star.userId);
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("UPDATE users SET anonymised_at = now() WHERE id = $1", [scrubbedFan.userId]),
    );
    await waitOnExecutionContext(ctx);

    const response = await fetchWorker(
      new Request(`https://api.test/public/followers?username=${star.username}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: { username: string }[] };
    expect(body.users.some((u) => u.username === scrubbedFan.username)).toBe(false);
    expect(body.users.some((u) => u.username === fan.username)).toBe(true);
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

  /**
   * Enumeration fix (board item 59 follow-up). Same property as the
   * followers case above, mirrored for the join column this route anchors
   * on (`follower_id`, not `followee_id`).
   */
  it("omits a scrubbed (anonymised) followee while keeping an ordinary one", async () => {
    const follower = await createVerifiedActor();
    const scrubbedFollowee = await createVerifiedActor();
    await seedFollow(follower.userId, star.userId);
    await seedFollow(follower.userId, scrubbedFollowee.userId);
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("UPDATE users SET anonymised_at = now() WHERE id = $1", [scrubbedFollowee.userId]),
    );
    await waitOnExecutionContext(ctx);

    const response = await fetchWorker(
      new Request(`https://api.test/public/following?username=${follower.username}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: { username: string }[] };
    expect(body.users.some((u) => u.username === scrubbedFollowee.username)).toBe(false);
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
