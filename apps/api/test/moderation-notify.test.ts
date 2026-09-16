import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

import { sendModerationNotice } from "../src/moderation/notify-author";

/** Capture Postmark sends for assertions */
let sentEmails: Array<Record<string, unknown>> = [];

/**
 * Helper to capture a Postmark send: stubs fetch, runs a fn that calls sendModerationNotice,
 * and returns the parsed JSON body sent to Postmark.
 */
async function captureSend(
  fn: () => Promise<void>,
): Promise<Record<string, unknown>> {
  sentEmails = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.postmarkapp.com/email") {
        // Can't capture body here easily, so we'll use the module-level sentEmails instead
      }
      return new Response(
        JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "test" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );

  await fn();

  // For this function, we need to intercept the fetch more carefully
  vi.unstubAllGlobals();

  if (sentEmails.length === 0) {
    throw new Error("No email was sent");
  }

  return sentEmails[0]!;
}

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

beforeEach(() => {
  sentEmails = [];
});

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
