import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

/**
 * handle-at-signup Task 4: the post-signup "choose a handle before you may
 * publish" gate (`requireChosenUsername` in src/routes/posts.ts) is GONE — a
 * handle is chosen once, at signup (src/routes/signup.ts), so a verified user
 * is never blocked from publishing for lacking one. This file used to pin the
 * removed gate; it now pins its absence.
 */
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

let actor: Actor;
beforeAll(async () => { actor = await createVerifiedActor(); });
afterAll(async () => { await deleteCreatedUsers(); });

describe("publish no longer gates on a separate onboarding step", () => {
  it("lets a verified user save a DRAFT", async () => {
    const response = await post(actor, { title: "Draft ok", markdownSource: "x", status: "draft" });
    expect(response.status).toBe(201);
  });

  it("lets a freshly-verified user PUBLISH immediately — the handle already came from signup", async () => {
    const fresh = await createVerifiedActor();
    const response = await post(fresh, { title: "Pub ok", markdownSource: "x", status: "published" });
    expect(response.status).toBe(201);
  });
});
