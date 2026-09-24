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
    // ⚠️ restoreAllMocks, not each test's own `errorSpy.mockRestore()` alone
    // (still called per-test, belt-and-braces): a test whose OWN assertion
    // throws before reaching that line leaves the console.error spy attached
    // for every later test in this file, silently accumulating call counts
    // across tests — caught by mutation-testing the leak-detection tests
    // below (a real bug in the harness, not the guard, but the guard's own
    // "logs nothing on success" negative control is what surfaced it).
    vi.restoreAllMocks();
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

  /**
   * ⚠️ 2026-09-24 — the one property this whole change exists for: a failed
   * verification must LOG WHY, because the caller's shared 403 (signup.ts)
   * deliberately cannot say, and `success: false` alone cannot distinguish
   * `missing-input-secret` from `invalid-input-response` from a hostname
   * mismatch — five different production outages that all look identical
   * from outside. Anti-vacuity: the "unaffected on success" case right
   * below is the negative control — without it, a version that logs on
   * EVERY call (not just failures) would also pass "logs on failure".
   */
  describe("⚠️ logs error-codes on failure, and ONLY on failure — never the secret or token", () => {
    it("logs the error-codes array when success is false", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ success: false, "error-codes": ["invalid-input-secret"] }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        ),
      );

      const result = await verifyTurnstile(env, "a-real-looking-token", "203.0.113.9");

      expect(result).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message, meta] = errorSpy.mock.calls[0]!;
      expect(message).toBe("turnstile siteverify failed");
      expect(meta).toEqual({ errorCodes: ["invalid-input-secret"] });

      // ⚠️ THE WHOLE POINT: neither the secret nor the token may appear
      // ANYWHERE in what was logged, in either logged argument.
      const logged = JSON.stringify(errorSpy.mock.calls[0]);
      expect(logged).not.toContain(env.TURNSTILE_SECRET_KEY);
      expect(logged).not.toContain("a-real-looking-token");

      errorSpy.mockRestore();
    });

    it("logs an empty array (not undefined, not a crash) when error-codes is absent from a failed response", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ success: false }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
      );

      expect(await verifyTurnstile(env, "tok")).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith("turnstile siteverify failed", { errorCodes: [] });

      errorSpy.mockRestore();
    });

    it("⚠️ negative control — logs NOTHING when success is true (the property this whole suite is guarding, not just 'logs on failure')", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ success: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
      );

      expect(await verifyTurnstile(env, "tok")).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });

  /**
   * ⚠️ THE EXISTING CONTRACT MUST SURVIVE THIS CHANGE UNTOUCHED: a network
   * failure or a non-JSON body still REJECTS the promise (never resolves
   * `false`, never resolves `true`) — this file's own header/verifyTurnstile's
   * doc comment says callers treat a rejection the same as a failed
   * verification. Logging must not intercept or swallow that.
   */
  it("still REJECTS (never resolves) on a network-level fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unreachable");
      }),
    );

    await expect(verifyTurnstile(env, "tok")).rejects.toThrow("network unreachable");
  });

  it("still REJECTS on a non-JSON response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>not json</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    await expect(verifyTurnstile(env, "tok")).rejects.toThrow();
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
