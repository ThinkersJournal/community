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

describe("#113 plan B — the appeal and delete-request links", () => {
  const appealUrl = "https://community.thinkersjournal.com/appeal?token=a";
  const deleteRequestUrl = "https://community.thinkersjournal.com/account/delete-request?token=d";

  it("warn carries the appeal link only", async () => {
    await sendAccountActionNotice(env, "u@example.test", { kind: "warn", reason: "r", appealUrl });
    expect(String(sent[0]!.TextBody)).toContain(appealUrl);
    expect(String(sent[0]!.TextBody)).toContain("within 30 days");
    expect(String(sent[0]!.TextBody)).not.toContain("/account/delete-request");
  });

  it("suspend and ban carry both links and say what a deletion request does", async () => {
    for (const kind of ["suspend", "ban"] as const) {
      sent = [];
      await sendAccountActionNotice(env, "u@example.test", {
        kind,
        reason: "r",
        suspendedUntil: kind === "suspend" ? new Date("2026-10-08T04:00:00.000Z") : undefined,
        appealUrl,
        deleteRequestUrl,
      });
      const text = String(sent[0]!.TextBody);
      expect(text).toContain(appealUrl);
      expect(text).toContain(deleteRequestUrl);
      expect(text).toContain("You can also ask for your account to be deleted");
      expect(text).toContain("unless it is under a legal hold");
      expect(String(sent[0]!.HtmlBody)).toContain(`href="${deleteRequestUrl}"`);
    }
  });
});
