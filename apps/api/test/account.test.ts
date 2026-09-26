import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

/**
 * Account deletion request/cancel (board item 59 = Option C).
 *
 * ⚠️ REQUESTING DELETION MUST NOT KILL THE SESSION — see src/routes/account.ts's
 * header. The 30-day grace period has to be exercisable, so every assertion
 * below that follows a `POST /account/delete` with ANOTHER authenticated call
 * (using the SAME cookie) is pinning that property, not incidental.
 */

const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function accountStatus(actor: Actor): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/account", {
      headers: { Cookie: actor.cookie },
    }),
  );
}

function requestDeletion(actor: Actor): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/account/delete", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
      },
    }),
  );
}

function cancelDeletion(actor: Actor): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/account/delete/cancel", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
      },
    }),
  );
}

async function deletionRequestedAt(userId: string): Promise<Date | null> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ deletion_requested_at: Date | null }>(
      "SELECT deletion_requested_at FROM users WHERE id = $1",
      [userId],
    );
    return rows[0]?.deletion_requested_at ?? null;
  });
  await waitOnExecutionContext(ctx);
  return v;
}

afterAll(async () => {
  await deleteCreatedUsers();
});

describe("GET /account", () => {
  it("401s with no session", async () => {
    const response = await fetchWorker(new Request("https://api.test/account"));
    expect(response.status).toBe(401);
  });

  it("reports deletionRequestedAt: null before any request", async () => {
    const actor = await createVerifiedActor();
    const response = await accountStatus(actor);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deletionRequestedAt: string | null };
    expect(body.deletionRequestedAt).toBeNull();
  });
});

describe("POST /account/delete", () => {
  it("stamps deletion_requested_at and leaves the session usable", async () => {
    const actor = await createVerifiedActor();

    const response = await requestDeletion(actor);
    expect(response.status).toBe(200);
    expect(await deletionRequestedAt(actor.userId)).not.toBeNull();

    // ⚠️ THE GRACE-PERIOD PROPERTY: the SAME cookie still authenticates.
    // Deletion must not be a self-inflicted lockout — see the file header.
    const status = await accountStatus(actor);
    expect(status.status).toBe(200);
    const body = (await status.json()) as { deletionRequestedAt: string | null };
    expect(body.deletionRequestedAt).not.toBeNull();
  });

  it("is idempotent — requesting twice just restamps the timestamp, never errors", async () => {
    const actor = await createVerifiedActor();

    expect((await requestDeletion(actor)).status).toBe(200);
    expect((await requestDeletion(actor)).status).toBe(200);
    expect(await deletionRequestedAt(actor.userId)).not.toBeNull();
  });

  it("403s an origin-less request (runs the standard mutating pipeline)", async () => {
    const actor = await createVerifiedActor();
    const response = await fetchWorker(
      new Request("https://api.test/account/delete", {
        method: "POST",
        headers: { Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken },
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /account/delete/cancel", () => {
  it("clears deletion_requested_at back to NULL", async () => {
    const actor = await createVerifiedActor();
    await requestDeletion(actor);
    expect(await deletionRequestedAt(actor.userId)).not.toBeNull();

    const response = await cancelDeletion(actor);
    expect(response.status).toBe(200);

    // ⚠️ THE ONE TEST WORTH WRITING EXPLICITLY (per the PM's own note): a
    // cancel that leaves the row matchable is silent data loss 30 days later.
    expect(await deletionRequestedAt(actor.userId)).toBeNull();
  });

  it("is a no-op 200 when nothing is pending", async () => {
    const actor = await createVerifiedActor();
    const response = await cancelDeletion(actor);
    expect(response.status).toBe(200);
    expect(await deletionRequestedAt(actor.userId)).toBeNull();
  });
});
