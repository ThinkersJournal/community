import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { postmarkSend } from "../src/auth/postmark";

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
