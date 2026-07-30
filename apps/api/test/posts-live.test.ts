import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";

const ALLOWED_ORIGIN = "http://localhost:8787";
const POST = "018f0000-0000-7000-8000-000000000001";
function wsReq(url: string, origin = ALLOWED_ORIGIN): Request {
  return new Request(url, { headers: { Upgrade: "websocket", Origin: origin } });
}

describe("GET /posts/live (unauthed, origin-checked)", () => {
  it("403s a cross-site Origin even without a session", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(wsReq(`https://api.test/posts/live?postId=${POST}`, "https://evil.example"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(403);
  });

  it("400s a missing or malformed postId", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(wsReq("https://api.test/posts/live?postId=not-a-uuid"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(400);
  });

  it("426s a non-upgrade GET (valid origin + postId)", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request(`https://api.test/posts/live?postId=${POST}`, { headers: { Origin: ALLOWED_ORIGIN } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(426);
  });

  it("101s a valid upgrade with NO session (anonymous allowed) and forwards to the post's DO", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(wsReq(`https://api.test/posts/live?postId=${POST}`), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(101);
    resp.webSocket?.accept();
    resp.webSocket?.close();
  });
});
