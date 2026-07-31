import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers, type Actor } from "./actor";

afterAll(deleteCreatedUsers);

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}
async function seedNotif(recipientId: string, actorId: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(`INSERT INTO notifications (recipient_id, actor_id, kind) VALUES ($1,$2,'follow')`,
      [recipientId, actorId]));
  await waitOnExecutionContext(ctx);
}
const countReq = (a: Actor) =>
  new Request("https://api.test/notifications/unread-count", { headers: { Cookie: a.cookie } });
const seenReq = (a: Actor) =>
  new Request("https://api.test/notifications/seen", {
    method: "POST",
    headers: { Origin: "http://localhost:8787", Cookie: a.cookie, "X-CSRF-Token": a.csrfToken, "content-type": "application/json" },
    body: "{}",
  });
const count = async (a: Actor) =>
  ((await (await fetchWorker(countReq(a))).json()) as { count: number }).count;

describe("seen watermark vs unread count", () => {
  it("marking seen drops the badge to 0 without touching read_at", async () => {
    const me = await createVerifiedActor();
    const other = await createVerifiedActor();
    await seedNotif(me.userId, other.userId);
    expect(await count(me)).toBe(1);

    expect((await fetchWorker(seenReq(me))).status).toBe(200);
    expect(await count(me)).toBe(0);

    // read_at untouched: the row is still unread for email purposes.
    const ctx = createExecutionContext();
    const unread = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*) n FROM notifications WHERE recipient_id=$1 AND read_at IS NULL`, [me.userId]);
      return Number(rows[0]!.n);
    });
    await waitOnExecutionContext(ctx);
    expect(unread).toBe(1);
  });

  it("a notification created AFTER seen re-raises the badge", async () => {
    const me = await createVerifiedActor();
    const other = await createVerifiedActor();
    await fetchWorker(seenReq(me));                 // seen_at = now()
    await seedNotif(me.userId, other.userId);       // created_at > seen_at
    expect(await count(me)).toBe(1);
  });
});
