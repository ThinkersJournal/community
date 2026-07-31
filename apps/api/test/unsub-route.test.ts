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
  it("a valid token for a SINCE-DELETED user still returns a neutral 200 (no 500)", async () => {
    // Tokens never expire, and notification_prefs.user_id REFERENCES users(id):
    // minting for a user who is later deleted makes the INSERT hit a foreign-key
    // violation. The handler MUST swallow it and stay neutral, never leak a 500.
    const a = await createVerifiedActor();
    const token = await mintUnsubToken(env, a.userId);
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query(`DELETE FROM users WHERE id = $1`, [a.userId]));
    await waitOnExecutionContext(ctx);
    expect((await fetchWorker(unsubReq(token))).status).toBe(200);
    expect(await masterEnabled(a.userId)).toBeNull(); // user gone, no prefs row written
  });
});
