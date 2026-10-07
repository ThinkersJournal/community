import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyPostmark } from "@thinkersjournal/shared";

import { postmarkSend, postmarkSendOutcome } from "../src/auth/postmark";

/**
 * Task 5 (M2.3c) — the generic Postmark transport shared by the verification
 * send (stream "outbound") and the notification send (stream "broadcast").
 *
 * `cloudflare:test` does NOT export undici's `fetchMock` in the installed
 * `@cloudflare/vitest-pool-workers@0.18.4` (see test/turnstile.test.ts for the
 * verification), so this suite stubs the global `fetch` with `vi.stubGlobal`
 * and restores it in `afterEach` — otherwise the stub leaks into sibling pool
 * test files sharing this workerd isolate.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubPostmark(resp: { status?: number; body?: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(resp.body ?? { ErrorCode: 0 }), {
        status: resp.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const msg = {
  from: "noreply@thinkersjournal.com",
  to: "r@e.test",
  subject: "s",
  textBody: "t",
  htmlBody: "<p>t</p>",
  stream: "broadcast",
  headers: [{ Name: "List-Unsubscribe", Value: "<https://x/unsub?token=z>" }],
};

describe("postmarkSend", () => {
  it("returns true on 2xx + ErrorCode 0 and sends stream + headers", async () => {
    const calls = stubPostmark({ body: { ErrorCode: 0 } });
    expect(await postmarkSend(env, msg)).toBe(true);
    const sent = JSON.parse(String(calls[0]!.init!.body));
    expect(sent.MessageStream).toBe("broadcast");
    expect(sent.Headers).toEqual([
      { Name: "List-Unsubscribe", Value: "<https://x/unsub?token=z>" },
    ]);
    expect(new Headers(calls[0]!.init!.headers).get("X-Postmark-Server-Token")).toBe(
      env.POSTMARK_SERVER_TOKEN,
    );
  });

  it("returns false on a non-zero ErrorCode (e.g. unconfirmed stream)", async () => {
    stubPostmark({ body: { ErrorCode: 401, Message: "no stream" } });
    expect(await postmarkSend(env, msg)).toBe(false);
  });

  it("returns false on a non-2xx", async () => {
    stubPostmark({ status: 500, body: {} });
    expect(await postmarkSend(env, msg)).toBe(false);
  });

  it("returns false (never throws) on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    expect(await postmarkSend(env, msg)).toBe(false);
  });
});

describe("postmarkSendOutcome (security-alerting spec §4.4; PM ruling: parse the body on a non-2xx)", () => {
  it("an HTTP 422 whose JSON body carries ErrorCode 406 → errorCode 406 → permanent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubPostmark({ status: 422, body: { ErrorCode: 406, Message: "inactive: r@e.test" } });
    const outcome = await postmarkSendOutcome(env, msg);
    expect(outcome).toEqual({ ok: false, status: 422, errorCode: 406 });
    expect(classifyPostmark(outcome)).toBe("permanent");
  });

  it("never logs Message on a non-2xx: Postmark's 406 message names the recipient", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubPostmark({ status: 422, body: { ErrorCode: 406, Message: "inactive: r@e.test" } });
    await postmarkSendOutcome(env, msg);
    expect(JSON.stringify(err.mock.calls)).not.toContain("r@e.test");
    expect(err).toHaveBeenCalledWith("postmark send failed", expect.objectContaining({ status: 422, ErrorCode: 406 }));
  });

  it("a non-JSON non-2xx → errorCode null → transient; a thrown request → status null", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("Unauthorized", { status: 401 }))));
    expect(await postmarkSendOutcome(env, msg)).toEqual({ ok: false, status: 401, errorCode: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("boom"))),
    );
    const thrown = await postmarkSendOutcome(env, msg);
    expect(thrown).toEqual({ ok: false, status: null, errorCode: null });
    expect(classifyPostmark(thrown)).toBe("transient");
  });

  it("an accept → { ok: true }, and postmarkSend stays its boolean view", async () => {
    stubPostmark({ body: { ErrorCode: 0 } });
    expect(await postmarkSendOutcome(env, msg)).toEqual({ ok: true });
    stubPostmark({ status: 422, body: { ErrorCode: 300 } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await postmarkSend(env, msg)).toBe(false);
  });
});
