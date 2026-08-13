import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";

import worker from "../src";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

afterAll(async () => { await deleteCreatedUsers(); });

// POST /profile/username is GONE, not moved — the handle is now chosen once,
// at signup (apps/api/src/routes/signup.ts; apps/api/test/signup.test.ts
// covers the reserved/collision/suggestions behavior this suite used to own).

describe("GET /profile/me", () => {
  it("returns the viewer's id and handle for a session", async () => {
    const a = await createVerifiedActor();
    const response = await fetchWorker(
      new Request("https://api.test/profile/me", { headers: { Cookie: a.cookie } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { userId: string; username: string };
    expect(body.userId).toBe(a.userId);
    expect(body.username).toBe(a.username);
    expect(Object.keys(body).sort()).toEqual(["userId", "username"]);
  });

  it("401s LOGIN_REQUIRED without a session", async () => {
    const response = await fetchWorker(new Request("https://api.test/profile/me"));
    expect(response.status).toBe(401);
  });
});
