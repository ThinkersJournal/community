import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendAccountActionNotice } from "../src/moderation/notify-account";

let sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.postmarkapp.com/email") {
        sent.push(JSON.parse(init!.body as string) as Record<string, unknown>);
        return new Response(JSON.stringify({ ErrorCode: 0 }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("sendAccountActionNotice", () => {
  it("warn: says it is a warning and carries the reason, on the outbound stream", async () => {
    expect(await sendAccountActionNotice(env, "u@example.test", { kind: "warn", reason: "be <kind>" })).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.MessageStream).toBe("outbound");
    expect(sent[0]!.Subject).toBe("A warning about your account");
    expect(String(sent[0]!.TextBody)).toContain("be <kind>");
    expect(String(sent[0]!.HtmlBody)).toContain("be &lt;kind&gt;");
  });

  it("suspend: names the end date in UTC", async () => {
    await sendAccountActionNotice(env, "u@example.test", {
      kind: "suspend",
      reason: "r",
      suspendedUntil: new Date("2026-10-08T04:00:00.000Z"),
    });
    expect(String(sent[0]!.TextBody)).toContain("Thu, 08 Oct 2026 04:00:00 GMT");
  });

  it("ban: says the account is banned", async () => {
    await sendAccountActionNotice(env, "u@example.test", { kind: "ban", reason: "r" });
    expect(sent[0]!.Subject).toBe("Your account has been banned");
  });

  it("never throws when Postmark is down — returns false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(sendAccountActionNotice(env, "u@example.test", { kind: "warn", reason: "r" })).resolves.toBe(false);
  });
});
