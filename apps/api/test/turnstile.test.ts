import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyTurnstile } from "../src/auth/turnstile";

/**
 * `cloudflare:test`'s undici-style `fetchMock` (a `MockAgent`) is NOT exported
 * by the installed `@cloudflare/vitest-pool-workers@0.18.4` — its runtime
 * bundle (`dist/worker/lib/cloudflare/test.mjs`) only re-exports
 * env/createExecutionContext/SELF/... (verified by inspecting the bundle;
 * `MockAgent`/`MockScope`/etc. are declared, unexported, ambient types in
 * `types/cloudflare-test.d.ts`, present only to type OTHER internals). So this
 * suite falls back to stubbing the global `fetch` via `vi.stubGlobal`,
 * restored with `vi.unstubAllGlobals()` after every test so no mock leaks into
 * other pool test files sharing this workerd isolate.
 */
describe("verifyTurnstile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the siteverify request and resolves true on success", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const result = await verifyTurnstile(env, "tok-123", "203.0.113.5");

    expect(result).toBe(true);
    expect(capturedUrl).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    expect(capturedInit?.method).toBe("POST");
    expect(new Headers(capturedInit?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      secret: env.TURNSTILE_SECRET_KEY,
      response: "tok-123",
      remoteip: "203.0.113.5",
    });
  });

  it("omits remoteip from the body when not passed", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await verifyTurnstile(env, "tok-456");

    const body = JSON.parse(String(capturedInit?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      secret: env.TURNSTILE_SECRET_KEY,
      response: "tok-456",
    });
    expect("remoteip" in body).toBe(false);
  });

  it("resolves false when siteverify returns success: false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              "error-codes": ["invalid-input-response"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    expect(await verifyTurnstile(env, "bad-token")).toBe(false);
  });

  it("never caches: two calls against a stub that flips success both hit fetch", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response(JSON.stringify({ success: calls === 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const first = await verifyTurnstile(env, "single-use-token");
    const second = await verifyTurnstile(env, "single-use-token");

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(calls).toBe(2);
  });
});
