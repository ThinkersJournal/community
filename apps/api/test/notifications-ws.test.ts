import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

/**
 * GET /notifications/ws — the authed WebSocket upgrade for the realtime bell
 * (M2.3b). See src/routes/notifications-ws.ts's header for the ordering this
 * pins: `isAllowedOrigin` (WS-hijack guard) -> `readCurrentSession` ->
 * `Upgrade` header check -> forward to the caller's OWN NotifyDO.
 */

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}

/** A verified actor who has ALSO chosen a handle — mirrors notifications.test.ts. */
async function onboardedActor(): Promise<Actor> {
  const a = await createVerifiedActor();
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query("UPDATE profiles SET username_chosen=true WHERE user_id=$1", [a.userId]));
  await waitOnExecutionContext(ctx);
  return a;
}

function wsReq(actor?: { cookie: string }, origin = "http://localhost:8787"): Request {
  const h: Record<string, string> = { Upgrade: "websocket", Origin: origin };
  if (actor) h.Cookie = actor.cookie;
  return new Request("https://api.test/notifications/ws", { headers: h });
}

afterAll(deleteCreatedUsers);

describe("GET /notifications/ws", () => {
  it("401s LOGIN_REQUIRED without a session", async () => {
    const r = await fetchWorker(wsReq());
    expect(r.status).toBe(401);
  });

  it("403s a cross-site Origin (WS-hijack guard)", async () => {
    const actor = await onboardedActor();
    const r = await fetchWorker(wsReq(actor, "https://evil.example"));
    expect(r.status).toBe(403);
  });

  it("426s a valid session without an Upgrade header", async () => {
    const actor = await onboardedActor();
    const r = await fetchWorker(
      new Request("https://api.test/notifications/ws", {
        headers: { Cookie: actor.cookie, Origin: "http://localhost:8787" },
      }),
    );
    expect(r.status).toBe(426);
  });

  it("routes a valid upgrade to the caller's OWN DO (getByName(session.userId))", async () => {
    const actor = await onboardedActor();
    // Spy: replace env.NOTIFY with a stub recording the name it was addressed by.
    // workerd (real, not mocked here) REJECTS `new Response(null, {status:101})`
    // without a `webSocket` — the same shape NotifyDO.fetch itself returns — so
    // the stub builds a real WebSocketPair rather than the bare 101 the brief
    // sketched, which throws "status codes ... 200 to 599" in this pool.
    let addressed: string | null = null;
    const notify = {
      getByName: (id: string) => {
        addressed = id;
        return {
          fetch: async () => {
            const [client, server] = Object.values(new WebSocketPair());
            server.accept();
            return new Response(null, { status: 101, webSocket: client });
          },
        };
      },
    };
    const ctx = createExecutionContext();
    const r = await worker.fetch(wsReq(actor), { ...env, NOTIFY: notify } as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(101);
    expect(addressed).toBe(actor.userId); // never a client-supplied id
  });
});
