import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

import { sendModerationNotice } from "../src/moderation/notify-author";

/**
 * Helper to capture sends with full request body inspection
 */
async function captureSendFull<T>(
  fn: () => Promise<T>,
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

async function withFailingPostmark<T>(
  fn: () => Promise<T>,
): Promise<T> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Postmark is down");
    }),
  );

  try {
    return await fn();
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
      sendModerationNotice(env, "a@b.test", {
        decision: "remove",
        wasHidden: true,
        subject: "post",
        postTitle: "Test Post",
        reason: "Repeat infringement.",
      }),
    );
    expect(sent.MessageStream).toBe("outbound");
  });

  it("puts the statement of reasons in the body", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", {
        decision: "keep_hidden",
        wasHidden: false,
        subject: "post",
        postTitle: "Test Post",
        reason: "Violates the guidelines.",
      }),
    );
    expect(String(sent.TextBody)).toContain("Violates the guidelines.");
  });

  it("restore with wasHidden: true has subject 'Your content has been restored'", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", {
        decision: "restore",
        wasHidden: true,
        subject: "post",
        postTitle: "Test Post",
        reason: "Mistaken.",
      }),
    );
    expect(sent.Subject).toBe("Your content has been restored");
  });

  it("restore with wasHidden: false sends nothing and returns true", async () => {
    let fetchWasCalled = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      fetchWasCalled = true;
      return new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const result = await sendModerationNotice(env, "a@b.test", {
      decision: "restore",
      wasHidden: false,
      subject: "post",
      postTitle: "Test Post",
      reason: "Mistaken.",
    });

    expect(result).toBe(true);
    expect(fetchWasCalled).toBe(false);
    vi.unstubAllGlobals();
  });

  it("keep_hidden with wasHidden: true has subject 'Your content remains hidden after review'", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", {
        decision: "keep_hidden",
        wasHidden: true,
        subject: "post",
        postTitle: "Test Post",
        reason: "Violates the guidelines.",
      }),
    );
    expect(sent.Subject).toBe("Your content remains hidden after review");
  });

  it("keep_hidden with wasHidden: false has subject 'Your content has been hidden after review'", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", {
        decision: "keep_hidden",
        wasHidden: false,
        subject: "post",
        postTitle: "Test Post",
        reason: "Violates the guidelines.",
      }),
    );
    expect(sent.Subject).toBe("Your content has been hidden after review");
  });

  it("remove has subject 'Your content has been removed'", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", {
        decision: "remove",
        wasHidden: true,
        subject: "post",
        postTitle: "Test Post",
        reason: "Repeat infringement.",
      }),
    );
    expect(sent.Subject).toBe("Your content has been removed");
  });

  it("includes post title and type in the body", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", {
        decision: "remove",
        wasHidden: true,
        subject: "post",
        postTitle: "My Test Post",
        reason: "x",
      }),
    );
    expect(String(sent.TextBody)).toContain('This is about your post "My Test Post".');
  });

  it("includes comment type in the body for comments", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", {
        decision: "remove",
        wasHidden: true,
        subject: "comment",
        postTitle: "Parent Post",
        reason: "x",
      }),
    );
    expect(String(sent.TextBody)).toContain('This is about your comment on "Parent Post".');
  });

  it("HTML-escapes the title in the HTML body only", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", {
        decision: "remove",
        wasHidden: true,
        subject: "post",
        postTitle: "<script>alert('xss')</script>",
        reason: "x",
      }),
    );
    // TextBody is plain text, so no HTML escaping
    expect(String(sent.TextBody)).toContain("<script>alert('xss')</script>");
    // HtmlBody must be escaped
    expect(String(sent.HtmlBody)).toContain("&lt;script&gt;alert('xss')&lt;/script&gt;");
    expect(String(sent.HtmlBody)).not.toContain("<script>alert");
  });

  it("HTML-escapes the reason in the HTML body", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", {
        decision: "remove",
        wasHidden: true,
        subject: "post",
        postTitle: "Test Post",
        reason: "<script>x</script> & co",
      }),
    );
    expect(String(sent.HtmlBody)).toContain("&lt;script&gt;x&lt;/script&gt; &amp; co");
    expect(String(sent.HtmlBody)).not.toContain("<script>");
  });

  // ⚠️ A decision that succeeded in the database must not report failure
  // because Postmark was down.
  it("NEVER THROWS when the send fails", async () => {
    await expect(
      withFailingPostmark(() =>
        sendModerationNotice(env, "a@b.test", {
          decision: "remove",
          wasHidden: true,
          subject: "post",
          postTitle: "Test Post",
          reason: "x",
        }),
      ),
    ).resolves.not.toThrow();
  });
});
