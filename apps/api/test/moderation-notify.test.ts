import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

import { sendModerationNotice } from "../src/moderation/notify-author";

/**
 * Helper to capture sends with full request body inspection
 */
async function captureSendFull(
  fn: () => Promise<void>,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.postmarkapp.com/email") {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "test" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );

  await fn();
  vi.unstubAllGlobals();

  if (!captured) {
    throw new Error("No Postmark email was captured");
  }

  return captured;
}

async function withFailingPostmark(
  fn: () => Promise<void>,
): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Postmark is down");
    }),
  );

  try {
    await fn();
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendModerationNotice", () => {
  it("sends on the OUTBOUND stream, not broadcast", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", "remove", "Repeat infringement."),
    );
    expect(sent.MessageStream).toBe("outbound");
  });

  it("puts the statement of reasons in the body", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(
        env,
        "a@b.test",
        "keep_hidden",
        "Violates the guidelines.",
      ),
    );
    expect(String(sent.TextBody)).toContain("Violates the guidelines.");
  });

  it("says something different for a restore than for a removal", async () => {
    const restore = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", "restore", "Mistaken."),
    );
    const remove = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", "remove", "Mistaken."),
    );
    expect(restore.Subject).not.toBe(remove.Subject);
  });

  it("HTML-escapes the reason in the HTML body", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", "remove", "<script>x</script> & co"),
    );
    expect(String(sent.HtmlBody)).toContain("&lt;script&gt;x&lt;/script&gt; &amp; co");
    expect(String(sent.HtmlBody)).not.toContain("<script>");
  });

  // ⚠️ A decision that succeeded in the database must not report failure
  // because Postmark was down.
  it("NEVER THROWS when the send fails", async () => {
    await expect(
      withFailingPostmark(() =>
        sendModerationNotice(env, "a@b.test", "remove", "x"),
      ),
    ).resolves.toBeUndefined();
  });
});
