import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

const ALLOWED_ORIGIN = "http://localhost:8787";

function post(actor: Actor, body: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  return worker
    .fetch(
      new Request("https://api.test/posts", {
        method: "POST",
        headers: {
          Origin: ALLOWED_ORIGIN,
          Cookie: actor.cookie,
          "X-CSRF-Token": actor.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    )
    .then(async (r) => {
      await waitOnExecutionContext(ctx);
      return r;
    });
}

async function chooseHandle(userId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE profiles SET username_chosen = true WHERE user_id = $1", [userId]),
  );
  await waitOnExecutionContext(ctx);
}

let actor: Actor;
beforeAll(async () => { actor = await createVerifiedActor(); });
afterAll(async () => { await deleteCreatedUsers(); });

describe("publish requires a chosen username", () => {
  it("lets a not-yet-onboarded user save a DRAFT", async () => {
    const response = await post(actor, { title: "Draft ok", markdownSource: "x", status: "draft" });
    expect(response.status).toBe(201);
  });

  it("blocks PUBLISH with USERNAME_REQUIRED before onboarding", async () => {
    const response = await post(actor, { title: "Pub blocked", markdownSource: "x", status: "published" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("USERNAME_REQUIRED");
  });

  it("allows PUBLISH after a handle is chosen", async () => {
    await chooseHandle(actor.userId);
    const response = await post(actor, { title: "Pub ok", markdownSource: "x", status: "published" });
    expect(response.status).toBe(201);
  });
});
