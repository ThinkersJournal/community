import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

/** A verified actor who has ALSO chosen a handle (so the onboarding gate passes). */
async function onboardedActor(): Promise<Actor> {
  const actor = await createVerifiedActor();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE profiles SET username_chosen = true WHERE user_id = $1", [actor.userId]),
  );
  await waitOnExecutionContext(ctx);
  return actor;
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

  it("409s USERNAME_REQUIRED for a verified follower who has not chosen a handle", async () => {
    const noHandle = await createVerifiedActor(); // username_chosen stays false
    const response = await follow(noHandle, bob.userId);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("USERNAME_REQUIRED");
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
