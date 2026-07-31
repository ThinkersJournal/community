import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import worker from "../src";
import { createVerifiedActor, deleteCreatedUsers, type Actor } from "./actor";

afterAll(deleteCreatedUsers);

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}
function getReq(a: Actor): Request {
  return new Request("https://api.test/notification-prefs", { headers: { Cookie: a.cookie } });
}
function putReq(a: Actor, body: unknown): Request {
  return new Request("https://api.test/notification-prefs", {
    method: "PUT",
    headers: {
      Origin: "http://localhost:8787", Cookie: a.cookie,
      "X-CSRF-Token": a.csrfToken, "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("/notification-prefs", () => {
  it("GET returns spec defaults when no row exists", async () => {
    const a = await createVerifiedActor();
    const r = await fetchWorker(getReq(a));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      masterEnabled: true, direct: "instant", reactions: "digest", follows: "digest",
    });
  });

  it("PUT upserts and GET reflects it", async () => {
    const a = await createVerifiedActor();
    const body = { masterEnabled: false, direct: "off", reactions: "instant", follows: "digest" };
    expect((await fetchWorker(putReq(a, body))).status).toBe(200);
    expect(await (await fetchWorker(getReq(a))).json()).toEqual(body);
  });

  it("PUT rejects an invalid channel with 400", async () => {
    const a = await createVerifiedActor();
    const r = await fetchWorker(putReq(a, { masterEnabled: true, direct: "weekly", reactions: "digest", follows: "digest" }));
    expect(r.status).toBe(400);
  });

  it("GET without a session is 401", async () => {
    const r = await fetchWorker(new Request("https://api.test/notification-prefs"));
    expect(r.status).toBe(401);
  });
});
