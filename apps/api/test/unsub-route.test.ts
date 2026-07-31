import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import worker from "../src";
import { withClient } from "../src/db/client";
import { mintUnsubToken } from "../src/notifications/unsub-token";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

afterAll(deleteCreatedUsers);
async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}
async function masterEnabled(userId: string): Promise<boolean | null> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ m: boolean }>(
      `SELECT master_enabled m FROM notification_prefs WHERE user_id=$1`, [userId]);
    return rows[0]?.m ?? null;
  });
  await waitOnExecutionContext(ctx);
  return v;
}
const unsubReq = (token: string) =>
  new Request(`https://api.test/unsub?token=${encodeURIComponent(token)}`, { method: "POST" });

describe("POST /unsub", () => {
  it("a valid token sets master_enabled=false and returns 200", async () => {
    const a = await createVerifiedActor();
    expect((await fetchWorker(unsubReq(await mintUnsubToken(env, a.userId)))).status).toBe(200);
    expect(await masterEnabled(a.userId)).toBe(false);
  });
  it("an invalid token still returns a neutral 200 and changes nothing", async () => {
    const a = await createVerifiedActor();
    expect((await fetchWorker(unsubReq("garbage.token"))).status).toBe(200);
    expect(await masterEnabled(a.userId)).toBeNull(); // no row created
  });
  it("needs no session or CSRF (cross-origin one-click)", async () => {
    const a = await createVerifiedActor();
    const r = await fetchWorker(unsubReq(await mintUnsubToken(env, a.userId))); // no Cookie/Origin/CSRF
    expect(r.status).toBe(200);
  });
});
