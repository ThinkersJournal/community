import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** Open a hibernatable client socket to a post's PostLiveDO and collect frames. */
async function connect(postId: string): Promise<{ ws: WebSocket; messages: string[] }> {
  const stub = env.POST_LIVE.getByName(postId);
  const resp = await stub.fetch("https://do/live", { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error("expected a webSocket");
  ws.accept();
  const messages: string[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(e.data as string);
  });
  return { ws, messages };
}

describe("PostLiveDO", () => {
  it("101s a websocket upgrade and broadcasts a content-free {type} frame to all sockets", async () => {
    const a = await connect("post-1");
    const b = await connect("post-1");
    await env.POST_LIVE.getByName("post-1").push("comment");
    await new Promise((r) => setTimeout(r, 50));
    expect(a.messages).toEqual([JSON.stringify({ type: "comment" })]);
    expect(b.messages).toEqual([JSON.stringify({ type: "comment" })]);
    a.ws.close();
    b.ws.close();
  });

  it("frames carry NOTHING user-derived (no ids/bodies/counts)", async () => {
    const a = await connect("post-2");
    await env.POST_LIVE.getByName("post-2").push("reaction");
    await new Promise((r) => setTimeout(r, 50));
    const frame = a.messages[0] ?? "";
    // content-free: exactly {type}, nothing user-derived (no post id, body, or count)
    expect(JSON.parse(frame)).toEqual({ type: "reaction" });
    expect(frame).not.toContain("post-2");
    a.ws.close();
  });

  it("426s a non-upgrade request", async () => {
    const resp = await env.POST_LIVE.getByName("x").fetch("https://do/live");
    expect(resp.status).toBe(426);
  });

  it("accepts a mixed-case Upgrade token (case-insensitive per RFC 6455)", async () => {
    const resp = await env.POST_LIVE.getByName("casing").fetch("https://do/live", {
      headers: { Upgrade: "WebSocket" },
    });
    expect(resp.status).toBe(101);
    resp.webSocket?.accept();
    resp.webSocket?.close();
  });

  it("survives hibernation: a socket connected before eviction still receives a push after", async () => {
    const { ws, messages } = await connect("hiber");
    const stub = env.POST_LIVE.getByName("hiber");
    await evictDurableObject(stub);
    await stub.push("comment");
    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toEqual([JSON.stringify({ type: "comment" })]);
    ws.close();
  });
});
