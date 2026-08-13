import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createUnverifiedActor, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * A verified actor. Named `onboardedActor` (kept, not renamed, to hold this
 * file's diff to the handle-at-signup cleanup) from when it also had to flip
 * a now-retired onboarding flag marking a handle as chosen — every account
 * has a handle from signup now, so a plain verified actor already qualifies.
 */
async function onboardedActor(): Promise<Actor> {
  return createVerifiedActor();
}

function follow(actor: Actor, followeeId: string): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/follows", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ followeeId }),
    }),
  );
}

function unfollow(actor: Actor, followeeId: string): Promise<Response> {
  return fetchWorker(
    new Request(`https://api.test/follows/${followeeId}`, {
      method: "DELETE",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
      },
    }),
  );
}

async function edgeExists(followerId: string, followeeId: string): Promise<boolean> {
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

let alice: Actor;
let bob: Actor;
beforeAll(async () => {
  alice = await onboardedActor();
  bob = await onboardedActor();
});
afterAll(async () => { await deleteCreatedUsers(); });

describe("POST /follows", () => {
  it("creates the edge (idempotently) and 201s", async () => {
    const r1 = await follow(alice, bob.userId);
    expect(r1.status).toBe(201);
    expect(await edgeExists(alice.userId, bob.userId)).toBe(true);
    // Idempotent: a repeat is still 201 and does not error.
    const r2 = await follow(alice, bob.userId);
    expect(r2.status).toBe(201);
  });

  it("400s CANNOT_FOLLOW_SELF", async () => {
    const response = await follow(alice, alice.userId);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("CANNOT_FOLLOW_SELF");
  });

  it("400s CANNOT_FOLLOW_SELF when the self-uuid's case differs from the app guard's", async () => {
    // zod's uuid regex accepts mixed-case hex, so an upper-cased self-id slips
    // past the case-sensitive `followeeId === userId` app guard and must be
    // caught by the `follows_no_self` DB CHECK (23514) instead.
    const response = await follow(alice, alice.userId.toUpperCase());
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("CANNOT_FOLLOW_SELF");
  });

  it("404s NOT_FOUND for a nonexistent followee", async () => {
    const response = await follow(alice, crypto.randomUUID());
    expect(response.status).toBe(404);
  });

  it("400s INVALID_INPUT for a non-uuid followeeId", async () => {
    const response = await follow(alice, "not-a-uuid");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it("403s EMAIL_NOT_VERIFIED for an unverified follower", async () => {
    const unverified = await createUnverifiedActor();
    const response = await follow(unverified, bob.userId);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("a verified follower with no separate onboarding step can follow immediately (handle comes from signup)", async () => {
    const noExtraStep = await createVerifiedActor();
    const response = await follow(noExtraStep, bob.userId);
    expect(response.status).toBe(201);
  });
});

describe("DELETE /follows/:followeeId", () => {
  it("removes the edge and 200s", async () => {
    await follow(alice, bob.userId);
    const response = await unfollow(alice, bob.userId);
    expect(response.status).toBe(200);
    expect(await edgeExists(alice.userId, bob.userId)).toBe(false);
  });

  it("is a no-op (still 200) when not following", async () => {
    const response = await unfollow(alice, bob.userId);
    expect(response.status).toBe(200);
  });

  it("400s INVALID_INPUT for a non-uuid followeeId", async () => {
    const response = await unfollow(alice, "not-a-uuid");
    expect(response.status).toBe(400);
  });
});

async function notifsFor(
  recipientId: string,
): Promise<Array<{ kind: string; actorId: string }>> {
  const ctx = createExecutionContext();
  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ kind: string; actor_id: string }>(
      "SELECT kind, actor_id FROM notifications WHERE recipient_id=$1 ORDER BY id",
      [recipientId],
    );
    return rows;
  });
  await waitOnExecutionContext(ctx);
  return rows.map((r) => ({ kind: r.kind, actorId: r.actor_id }));
}

describe("follow notifications (M2.3a)", () => {
  it("following notifies the followee once, and re-follow after unfollow does not duplicate", async () => {
    const follower = await onboardedActor();
    const followee = await onboardedActor();
    await follow(follower, followee.userId);
    await unfollow(follower, followee.userId);
    await follow(follower, followee.userId); // re-follow
    expect(await notifsFor(followee.userId)).toEqual([
      { kind: "follow", actorId: follower.userId },
    ]);
  });
});

function followRequest(actor: Actor, followeeId: string): Request {
  return new Request("https://api.test/follows", {
    method: "POST",
    headers: {
      Origin: ALLOWED_ORIGIN,
      Cookie: actor.cookie,
      "X-CSRF-Token": actor.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ followeeId }),
  });
}

describe("follow notify push (M2.3b)", () => {
  function spyingNotify(pushed: Array<{ id: string; kind: string }>): {
    getByName: (id: string) => { push: (kind: string) => void; fetch: () => Promise<Response> };
  } {
    return {
      getByName: (id: string) => ({
        push: (kind: string) => {
          pushed.push({ id, kind });
        },
        fetch: async () => new Response(),
      }),
    };
  }

  it("pushes a realtime nudge to the followee's NotifyDO after a follow", async () => {
    const pushed: Array<{ id: string; kind: string }> = [];
    const follower = await onboardedActor();
    const followee = await onboardedActor();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      followRequest(follower, followee.userId),
      { ...env, NOTIFY: spyingNotify(pushed) } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    expect(pushed).toEqual([{ id: followee.userId, kind: "notification" }]);
  });

  it("a rejected self-follow pushes nothing (self-suppression)", async () => {
    const pushed: Array<{ id: string; kind: string }> = [];
    const solo = await onboardedActor();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      followRequest(solo, solo.userId),
      { ...env, NOTIFY: spyingNotify(pushed) } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
    expect(pushed).toEqual([]);
  });

  it("follow → unfollow → re-follow pushes EXACTLY ONCE (live-channel anti-spam)", async () => {
    // Finding 2 (M2.3b fix wave): M2.3a's dedup already proves the re-follow
    // adds no second DB row ("re-follow after unfollow does not duplicate",
    // above); this proves the LIVE push honors the same guarantee — a
    // follow/unfollow/re-follow cycle cannot spam the followee's bell with
    // realtime nudges, because the re-follow's insert conflicts (rowCount 0)
    // and notify() gates the push on a genuinely NEW row.
    const pushed: Array<{ id: string; kind: string }> = [];
    const follower = await onboardedActor();
    const followee = await onboardedActor();
    const notifyEnv = { ...env, NOTIFY: spyingNotify(pushed) } as never;

    const ctx1 = createExecutionContext();
    await worker.fetch(followRequest(follower, followee.userId), notifyEnv, ctx1);
    await waitOnExecutionContext(ctx1);

    const ctx2 = createExecutionContext();
    await worker.fetch(
      new Request(`https://api.test/follows/${followee.userId}`, {
        method: "DELETE",
        headers: {
          Origin: ALLOWED_ORIGIN,
          Cookie: follower.cookie,
          "X-CSRF-Token": follower.csrfToken,
        },
      }),
      notifyEnv,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);

    const ctx3 = createExecutionContext();
    await worker.fetch(followRequest(follower, followee.userId), notifyEnv, ctx3);
    await waitOnExecutionContext(ctx3);

    expect(pushed).toEqual([{ id: followee.userId, kind: "notification" }]);
  });

  it("a push failure does not fail the follow write", async () => {
    const notify = {
      getByName: () => ({
        push: () => {
          throw new Error("DO unavailable");
        },
        fetch: async () => new Response(),
      }),
    };
    const follower = await onboardedActor();
    const followee = await onboardedActor();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      followRequest(follower, followee.userId),
      { ...env, NOTIFY: notify } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    expect(error).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("follow/unfollow busts the follower's KV followee cache (M2 KV cache)", () => {
  it("POST /follows deletes the follower's cache key", async () => {
    const follower = await onboardedActor();
    // Prime a stale entry, then follow — the write must invalidate it.
    await env.FOLLOWEES.put(`followees:${follower.userId}`, JSON.stringify([]));
    const r = await follow(follower, bob.userId);
    expect(r.status).toBe(201);
    expect(await env.FOLLOWEES.get(`followees:${follower.userId}`)).toBeNull();
  });

  it("DELETE /follows/:id deletes the follower's cache key", async () => {
    const follower = await onboardedActor();
    await follow(follower, bob.userId);
    await env.FOLLOWEES.put(`followees:${follower.userId}`, JSON.stringify([bob.userId]));
    const r = await unfollow(follower, bob.userId);
    expect(r.status).toBe(200);
    expect(await env.FOLLOWEES.get(`followees:${follower.userId}`)).toBeNull();
  });
});
