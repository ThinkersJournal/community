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

function chooseUsername(actor: Actor, username: string): Promise<Response> {
  return fetchWorker(
    new Request("https://api.test/profile/username", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ username }),
    }),
  );
}

async function usernameChosenFlag(userId: string): Promise<boolean> {
  const ctx = createExecutionContext();
  const flag = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ username_chosen: boolean }>(
      "SELECT username_chosen FROM profiles WHERE user_id=$1",
      [userId],
    );
    return rows[0]!.username_chosen;
  });
  await waitOnExecutionContext(ctx);
  return flag;
}

let actor: Actor;
beforeAll(async () => { actor = await createVerifiedActor(); });
afterAll(async () => { await deleteCreatedUsers(); });

describe("POST /profile/username", () => {
  it("sets a unique handle and flips username_chosen", async () => {
    const unique = `u${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const response = await chooseUsername(actor, unique);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { userId: string; username: string; usernameChosen: boolean };
    expect(body.userId).toBe(actor.userId);
    expect(body.username).toBe(unique);
    expect(body.usernameChosen).toBe(true);
    expect(await usernameChosenFlag(actor.userId)).toBe(true);
  });

  it.each([
    ["too short", "ab"],
    ["a hyphen", "ada-lovelace"],
    ["uppercase-only invalid chars", "ADA!"],
  ])("400s INVALID_INPUT on %s", async (_name, username) => {
    const a = await createVerifiedActor();
    const response = await chooseUsername(a, username);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it.each(["admin", "support", "official", "staff", "thinkersjournal"])(
    "400s INVALID_INPUT on reserved word %s",
    async (word) => {
      const a = await createVerifiedActor();
      const response = await chooseUsername(a, word);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("INVALID_INPUT");
    },
  );

  it("409s USERNAME_TAKEN when the handle is already in use", async () => {
    const first = await createVerifiedActor();
    const taken = `dup${crypto.randomUUID().replace(/-/g, "").slice(0, 17)}`;
    expect((await chooseUsername(first, taken)).status).toBe(200);
    const second = await createVerifiedActor();
    const response = await chooseUsername(second, taken);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("USERNAME_TAKEN");
  });

  it("409s USERNAME_ALREADY_SET on a second choice (immutable)", async () => {
    const a = await createVerifiedActor();
    expect((await chooseUsername(a, `u${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`)).status).toBe(200);
    const response = await chooseUsername(a, `u${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("USERNAME_ALREADY_SET");
  });

  it("403s EMAIL_NOT_VERIFIED for an unverified user", async () => {
    const unverified = await createUnverifiedActor();
    const response = await chooseUsername(unverified, `u${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
  });
});

describe("GET /profile/me", () => {
  it("returns the handle and usernameChosen for a session", async () => {
    const a = await createVerifiedActor();
    const response = await fetchWorker(
      new Request("https://api.test/profile/me", { headers: { Cookie: a.cookie } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { userId: string; username: string; usernameChosen: boolean };
    expect(body.userId).toBe(a.userId);
    expect(body.username).toBe(a.username);
    expect(body.usernameChosen).toBe(false);
  });

  it("401s LOGIN_REQUIRED without a session", async () => {
    const response = await fetchWorker(new Request("https://api.test/profile/me"));
    expect(response.status).toBe(401);
  });
});
