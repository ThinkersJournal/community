import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

import { escapeHtml } from "../src/auth/email-verify";
import { renderModerationNotice, sendModerationNotice } from "../src/moderation/notify-author";
import { DISPUTE_CONTACT_LINE, DISPUTE_EMAIL } from "@thinkersjournal/shared";

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

    try {
      const result = await sendModerationNotice(env, "a@b.test", {
        decision: "restore",
        wasHidden: false,
        subject: "post",
        postTitle: "Test Post",
        reason: "Mistaken.",
      });

      expect(result).toBe(true);
      expect(fetchWasCalled).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("remove with wasHidden: false has subject 'Your content has been removed'", async () => {
    // Not hidden beforehand: a different COPY entry (`remove:false`) from the
    // wasHidden: true case above, so it needs its own assertion.
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", {
        decision: "remove",
        wasHidden: false,
        subject: "post",
        postTitle: "Test Post",
        reason: "Repeat infringement.",
      }),
    );
    expect(sent.Subject).toBe("Your content has been removed");
    expect(String(sent.TextBody)).toContain("We reviewed your content and removed it");
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
    ).resolves.toBe(false);
  });
});

describe("#53 — the appeal link", () => {
  const appealUrl = "https://community.thinkersjournal.com/appeal?token=abc";

  it("keep_hidden and remove carry the appeal link and the 30-day window, in text and html", async () => {
    for (const decision of ["keep_hidden", "remove"] as const) {
      const sent = await captureSendFull(() =>
        sendModerationNotice(env, "a@b.test", {
          decision,
          wasHidden: true,
          subject: "post",
          postTitle: "T",
          reason: "r",
          appealUrl,
        }),
      );
      expect(String(sent.TextBody)).toContain(appealUrl);
      expect(String(sent.TextBody)).toContain("within 30 days");
      expect(String(sent.HtmlBody)).toContain(`href="${appealUrl}"`);
    }
  });

  it("a restore never carries it, even when a caller passes one", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", {
        decision: "restore",
        wasHidden: true,
        subject: "post",
        postTitle: "T",
        reason: "r",
        appealUrl,
      }),
    );
    // Control: this IS the restore notice, so the absence below is about the link.
    expect(sent.Subject).toBe("Your content has been restored");
    expect(String(sent.TextBody)).not.toContain("/appeal?token=");
    expect(String(sent.HtmlBody)).not.toContain("/appeal?token=");
  });
});

// #57 Q2 — the AUTHOR must never be told that a report or a notice prompted the
// decision, nor by whom. Reads every copy key, so a new key is covered too.
describe("author-facing copy (#57 Q2)", () => {
  it("no copy key mentions a report, a notice or a reporter", async () => {
    const { COPY } = await import("../src/moderation/notify-author");
    const keys = Object.keys(COPY);
    expect(keys.length).toBeGreaterThan(0);
    for (const [key, copy] of Object.entries(COPY)) {
      expect(`${copy.subject} ${copy.lead}`, key).not.toMatch(/report|notice|notif|complain|flag/i);
    }
  });
});

// #57 Q8=A — one generic redress sentence on ADVERSE notices only.
describe("redress sentence (#57 Q8)", () => {
  const base = { wasHidden: true, subject: "post", postTitle: "T", reason: "r" } as const;

  it("keep_hidden and remove carry it, in text and html, with and without the appeal link", async () => {
    const { REDRESS_SENTENCE } = await import("@thinkersjournal/shared");
    for (const decision of ["keep_hidden", "remove"] as const) {
      for (const appealUrl of [undefined, "https://community.thinkersjournal.com/appeal?token=a"]) {
        const sent = await captureSendFull(() => sendModerationNotice(env, "a@b.test", { ...base, decision, appealUrl }));
        expect(String(sent.TextBody), `${decision} ${String(appealUrl)}`).toContain(REDRESS_SENTENCE);
        expect(String(sent.HtmlBody)).toContain(REDRESS_SENTENCE);
        // Control: the appeal link is present exactly when given.
        expect(String(sent.TextBody).includes("/appeal?token=")).toBe(appealUrl !== undefined);
      }
    }
  });

  it("restore does not carry it", async () => {
    const sent = await captureSendFull(() => sendModerationNotice(env, "a@b.test", { ...base, decision: "restore" }));
    expect(sent.Subject).toBe("Your content has been restored");
    expect(String(sent.TextBody)).not.toContain("redress");
  });

  it("auto-hide pending-review notice does not carry it", async () => {
    const { sendAutoHideNotice } = await import("../src/moderation/notify-author");
    const sent = await captureSendFull(() => sendAutoHideNotice(env, "a@b.test", { subject: "post", postTitle: "T" }));
    expect(String(sent.TextBody)).not.toContain("redress");
  });

  it("names no statute or body, and is not a copy key (so the Q2 regexp is untouched)", async () => {
    const { REDRESS_SENTENCE } = await import("@thinkersjournal/shared");
    expect(REDRESS_SENTENCE).not.toMatch(/(DSA|Article|Art\.|Regulation|\d{4}\/\d+)/i);
    expect(REDRESS_SENTENCE).toMatch(/internal complaint/);
    expect(REDRESS_SENTENCE).toMatch(/out-of-court/);
    expect(REDRESS_SENTENCE).toMatch(/judicial redress/);
    expect(REDRESS_SENTENCE).toContain("dispute@thinkersjournal.com");
    expect(REDRESS_SENTENCE).toMatch(/not legal advice/);
  });
});

// #57 Q9 — onSent receives exactly what was sent, only on success, and a throw
// in it never changes the result.
describe("onSent record hook (#57 Q9)", () => {
  const n = { decision: "remove", wasHidden: true, subject: "post", postTitle: "T", reason: "r" } as const;

  it("is called with the same subject/text/html that Postmark received", async () => {
    let got: { subject: string; textBody: string; htmlBody: string } | undefined;
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", n, async (r) => {
        got = r;
      }),
    );
    expect(got).toBeDefined();
    expect(got!.subject).toBe(sent.Subject);
    expect(got!.textBody).toBe(sent.TextBody);
    expect(got!.htmlBody).toBe(sent.HtmlBody);
  });

  it("is NOT called when the send fails", async () => {
    let called = false;
    const ok = await withFailingPostmark(() =>
      sendModerationNotice(env, "a@b.test", n, async () => {
        called = true;
      }),
    );
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });

  it("a throwing hook does not fail the notice", async () => {
    const ok = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", n, async () => {
        throw new Error("db down");
      }),
    );
    expect(ok.Subject).toBe("Your content has been removed");
  });
});

// Guidelines link — copy only: names the version in force and links the public page.
describe("Community Guidelines link", () => {
  const base = { wasHidden: true, subject: "post", postTitle: "T", reason: "r" } as const;
  const URL_ = "https://community.thinkersjournal.com/guidelines";

  it("keep_hidden and remove name the version and link the page, in text and html", async () => {
    const { GUIDELINES_VERSION } = await import("@thinkersjournal/shared");
    for (const decision of ["keep_hidden", "remove"] as const) {
      for (const wasHidden of [true, false]) {
        const sent = await captureSendFull(() => sendModerationNotice(env, "a@b.test", { ...base, wasHidden, decision }));
        expect(String(sent.TextBody), `${decision}:${String(wasHidden)}`).toContain(`Community Guidelines (version ${GUIDELINES_VERSION}): ${URL_}`);
        expect(String(sent.HtmlBody)).toContain(`href="${URL_}"`);
        expect(String(sent.HtmlBody)).toContain(`(version ${GUIDELINES_VERSION})`);
      }
    }
  });

  it("restore, whose lead does not name the Guidelines, carries no link", async () => {
    const sent = await captureSendFull(() => sendModerationNotice(env, "a@b.test", { ...base, decision: "restore" }));
    expect(String(sent.TextBody)).not.toContain("/guidelines");
  });

  it("the added line mentions no report, notice, reporter (#57 Q2)", async () => {
    const { guidelinesLine } = await import("../src/moderation/notify-author");
    expect(guidelinesLine().text).not.toMatch(/report|notice|notif|complain|flag/i);
  });
});

// Notice outbox design F4 — CireSnave: "They should always have the option to
// email us at dispute@thinkersjournal.com whether they have a token or not."
// The pin for the author_decision kind.
//
// MUTATION CHECK (by reasoning; this suite could not be run when written):
// deleting `${DISPUTE_CONTACT_LINE}` from `textBody` in
// renderModerationNotice fails every `toContain(DISPUTE_CONTACT_LINE)` on
// TextBody below (and the "ends with" assertion); deleting the
// `<p>${escapeHtml(DISPUTE_CONTACT_LINE)}</p>` from `htmlBody` fails the
// HtmlBody ones; making either conditional on `appealUrl` fails the
// `appealUrl: undefined` rows. Each assertion has a control: the row is a
// notice that was actually rendered (its subject is checked), so the line's
// absence cannot be an empty render.
describe("dispute contact line (notice outbox F4)", () => {
  const base = { subject: "post", postTitle: "T", reason: "r" } as const;
  const appealUrl = "https://community.thinkersjournal.com/appeal?token=abc";
  const cases = [
    { decision: "keep_hidden", wasHidden: true },
    { decision: "keep_hidden", wasHidden: false },
    { decision: "remove", wasHidden: true },
    { decision: "remove", wasHidden: false },
    { decision: "restore", wasHidden: true },
  ] as const;

  it("every rendered author_decision notice carries it, in text and html, with and without an appeal link", () => {
    for (const c of cases) {
      for (const link of [undefined, appealUrl]) {
        const label = `${c.decision}:${String(c.wasHidden)} link=${String(link !== undefined)}`;
        const rendered = renderModerationNotice({ ...base, ...c, appealUrl: link });
        expect(rendered, label).not.toBeNull();
        // Control: a real notice for this pair, not a blank one.
        expect(rendered!.subject, label).toMatch(/^Your content /);
        expect(rendered!.textBody, label).toContain(DISPUTE_CONTACT_LINE);
        expect(rendered!.htmlBody, label).toContain(DISPUTE_CONTACT_LINE);
        expect(rendered!.textBody.trimEnd().endsWith(DISPUTE_CONTACT_LINE), label).toBe(true);
        // The line is independent of the link: present exactly when asked, absent otherwise.
        const expectsLink = link !== undefined && c.decision !== "restore";
        expect(rendered!.textBody.includes("/appeal?token="), label).toBe(expectsLink);
      }
    }
  });

  it("is what Postmark receives from sendModerationNotice, with no appeal link", async () => {
    const sent = await captureSendFull(() =>
      sendModerationNotice(env, "a@b.test", { ...base, decision: "remove", wasHidden: true }),
    );
    expect(sent.Subject).toBe("Your content has been removed");
    expect(String(sent.TextBody)).not.toContain("/appeal?token=");
    expect(String(sent.TextBody)).toContain(DISPUTE_CONTACT_LINE);
    expect(String(sent.HtmlBody)).toContain(DISPUTE_CONTACT_LINE);
  });

  it("names the dispute address, passes through escapeHtml unchanged, and says nothing about a report (#57 Q2)", () => {
    expect(DISPUTE_CONTACT_LINE).toContain(DISPUTE_EMAIL);
    expect(escapeHtml(DISPUTE_CONTACT_LINE)).toBe(DISPUTE_CONTACT_LINE);
    expect(DISPUTE_CONTACT_LINE).not.toMatch(/report|notice|notif|complain|flag/i);
  });

  it("a restore of never-hidden content renders nothing at all (null), so nothing is sent or queued", () => {
    expect(renderModerationNotice({ ...base, decision: "restore", wasHidden: false })).toBeNull();
  });
});
