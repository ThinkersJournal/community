import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Runs in the POOL project (real workerd) because it needs the `NOTIFY`
// Durable Object binding + real hibernatable WebSockets. NotifyDO is a dumb,
// content-free relay (see NotifyDO.ts doc comment) — these tests prove real
// WS delivery (not mocks), multi-socket broadcast, the 426 fallback, and
// (since `evictDurableObject` is available in this pool) hibernation
// survival: the socket must still receive a push() after the DO instance is
// torn down and re-woken.

/** Open a hibernatable client socket to a user's NotifyDO and collect messages. */
async function connect(userId: string): Promise<{ ws: WebSocket; messages: string[] }> {
  const stub = env.NOTIFY.getByName(userId);
  const resp = await stub.fetch("https://do/ws", { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error("expected a webSocket");
  ws.accept();
  const messages: string[] = [];
  // Braced body: an implicit-return arrow here (`=> messages.push(...)`) hands
  // the DOM event dispatcher `Array.push`'s numeric return value, which
  // workerd flags with a "returned a value ... will be ignored" console
  // warning on every message — noise this suite keeps out of test output.
  ws.addEventListener("message", (e) => {
    messages.push(e.data as string);
  });
  return { ws, messages };
}

describe("NotifyDO", () => {
  it("101s a WebSocket upgrade and pushes a content-free nudge to a connected socket", async () => {
    const { ws, messages } = await connect("user-a");

    await env.NOTIFY.getByName("user-a").push("notification");
    // allow the frame to arrive
    await new Promise((r) => setTimeout(r, 50));

    expect(messages).toContain(JSON.stringify({ type: "notification" }));
    // no content on the wire: no actor, no ids, no counts
    expect(messages.join()).not.toContain("actor");
    expect(messages.join()).not.toMatch(/id|count/i);

    ws.close();
  });

  it("does NOT echo client messages back (keepalives are a no-op, not an echo)", async () => {
    const { ws, messages } = await connect("no-echo");

    ws.send("keepalive");
    await new Promise((r) => setTimeout(r, 50));

    expect(messages).toHaveLength(0);

    ws.close();
  });

  it("broadcasts to MULTIPLE sockets on the same user's DO", async () => {
    const a = await connect("multi");
    const b = await connect("multi");

    await env.NOTIFY.getByName("multi").push("read");
    await new Promise((r) => setTimeout(r, 50));

    expect(a.messages).toContain(JSON.stringify({ type: "read" }));
    expect(b.messages).toContain(JSON.stringify({ type: "read" }));

    a.ws.close();
    b.ws.close();
  });

  it("426s a non-upgrade request", async () => {
    const resp = await env.NOTIFY.getByName("x").fetch("https://do/ws");

    expect(resp.status).toBe(426);
  });

  it("survives hibernation: a socket connected before eviction still receives a push after", async () => {
    const { ws, messages } = await connect("hiber");

    // Tears down the running DO instance (resetting in-memory state) but must
    // hibernate — not close — the open WebSocket per the DurableObjectEvictionOptions
    // default (`webSockets: "hibernate"`).
    await evictDurableObject(env.NOTIFY.getByName("hiber"));

    await env.NOTIFY.getByName("hiber").push("notification");
    await new Promise((r) => setTimeout(r, 50));

    expect(messages).toContain(JSON.stringify({ type: "notification" }));

    ws.close();
  });
});
