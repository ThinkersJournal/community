/**
 * T3 of the moderation author-notices design (#56): an AUTO-HIDE tells the
 * author, once, that their content is hidden pending review.
 *
 * ⚠️ WHAT THE NOTICE MAY NEVER CARRY (asserted over the full text AND html):
 * a reporter's identity, a report reason, or the number of reports. The
 * threshold is not disclosed either: disclosing it hands an attacker the number.
 *
 * ⚠️ NO APPEAL LINK. There is no `moderation_actions` row yet, and an appeal
 * attaches to a decision; the later decision notice carries the link.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { notifyAutoHidden } from "../src/moderation/notify-author";
import { createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

const ALLOWED_ORIGIN = "http://localhost:8787";

interface Sent {
  readonly to: string;
  readonly stream: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** `hidden_at` as a DIFFERENT connection saw it at the moment of the send. */
  readonly hiddenAtSeenAtSend: string | null;
}

/** One ordered log across the purge and the mail, so ORDER is assertable. */
let log: string[] = [];
let sent: Sent[] = [];
let watchRow: { table: "posts" | "comments"; id: string } | null = null;
let postmarkStatus = 200;
/** Runs inside the purge stub: after the hide, before the send. */
let betweenHideAndSend: (() => Promise<void>) | null = null;

async function run<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

async function hiddenAtOf(table: "posts" | "comments", id: string): Promise<string | null> {
  return run(async (c) => {
    const { rows } = await c.query<{ h: string | null }>(`SELECT hidden_at::text AS h FROM ${table} WHERE id = $1`, [id]);
    return rows[0]?.h ?? null;
  });
}

beforeEach(() => {
  log = [];
  sent = [];
  watchRow = null;
  postmarkStatus = 200;
  betweenHideAndSend = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.postmarkapp.com/email") {
        const b = JSON.parse(String(init?.body)) as Record<string, string>;
        const seen = watchRow === null ? null : await hiddenAtOf(watchRow.table, watchRow.id);
        log.push("mail");
        sent.push({
          to: b["To"]!, stream: b["MessageStream"]!, subject: b["Subject"]!,
          text: b["TextBody"]!, html: b["HtmlBody"]!, hiddenAtSeenAtSend: seen,
        });
        return new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "t" }), {
          status: postmarkStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function report(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const web = {
    fetch: async () => {
      log.push("purge");
      if (betweenHideAndSend !== null) await betweenHideAndSend();
      return new Response(JSON.stringify({ purged: 1 }), { status: 200 });
    },
  };
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://api.test/reports", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN, Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { ...env, WEB: web } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function createComment(actor: Actor, postId: string): Promise<string> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://api.test/comments", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN, Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ postId, markdownSource: "a comment" }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function titleOf(postId: string): Promise<string> {
  return run(async (c) => (await c.query<{ title: string }>(`SELECT title FROM posts WHERE id = $1`, [postId])).rows[0]!.title);
}

async function emailOf(userId: string): Promise<string> {
  return run(async (c) => (await c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0]!.email);
}

/** A link of any shape: a scheme, an href, the appeal path, or its token parameter. */
const NO_LINK = /https?:\/\/|href=|\/appeal|token=/i;

const REASONS = ["harassment", "hate", "spam", "harassment", "hate"] as const;
const reporters: Actor[] = [];
let author: Actor;

beforeAll(async () => {
  author = await createVerifiedActor();
  for (let i = 0; i < 5; i++) reporters.push(await createVerifiedActor());
});
afterAll(async () => {
  await deleteCreatedUsers();
});

/** Reports from reporters `from` .. `from + n - 1`. Each must 201. */
async function reportN(target: Record<string, unknown>, from: number, n: number): Promise<void> {
  for (let i = from; i < from + n; i++) {
    expect((await report(reporters[i]!, { ...target, reason: REASONS[i] })).status).toBe(201);
  }
}

describe("auto-hide author notice (#56)", () => {
  it("sends nothing for reports 1 and 2; the 3rd hides the post AND sends exactly one notice to the author", async () => {
    const postId = await createPublished(author);
    watchRow = { table: "posts", id: postId };

    await reportN({ postId }, 0, 2);
    expect(sent).toHaveLength(0);
    expect(await hiddenAtOf("posts", postId)).toBeNull();

    await reportN({ postId }, 2, 1);
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.to).toBe(await emailOf(author.userId));
    expect(m.stream).toBe("outbound");
    expect(m.text).toContain("pending review");
    expect(m.html).toContain("pending review");
    expect(m.text).toContain(await titleOf(postId));
    // No appeal link: nothing has been decided, so there is nothing to appeal.
    expect(m.text).not.toMatch(NO_LINK);
    expect(m.html).not.toMatch(NO_LINK);
    // The post was already hidden, as seen from ANOTHER connection, when it went.
    expect(m.hiddenAtSeenAtSend).not.toBeNull();
    // ...and the cache purge came first.
    expect(log).toEqual(["purge", "mail"]);
  });

  it("a 4th report on already-hidden content sends nothing more", async () => {
    const postId = await createPublished(author);
    await reportN({ postId }, 0, 3);
    expect(sent).toHaveLength(1);
    await reportN({ postId }, 3, 1);
    expect(sent).toHaveLength(1);
  });

  it("a comment: the copy names the parent post and says 'your comment'", async () => {
    const postId = await createPublished(author);
    const commentId = await createComment(author, postId);
    await reportN({ commentId }, 0, 3);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(await emailOf(author.userId));
    expect(sent[0]!.text).toContain(`your comment on "${await titleOf(postId)}"`);
    expect(sent[0]!.text).toContain("pending review");
    expect(sent[0]!.text).not.toMatch(NO_LINK);
    expect(sent[0]!.html).not.toMatch(NO_LINK);
  });

  it("never carries a reporter's identity, a report reason, or the number of reports", async () => {
    const postId = await createPublished(author);
    await reportN({ postId }, 0, 3);
    expect(sent).toHaveLength(1);
    const everything = `${sent[0]!.subject}\n${sent[0]!.text}\n${sent[0]!.html}`;
    for (const r of reporters.slice(0, 3)) {
      expect(everything).not.toContain(r.userId);
      expect(everything).not.toContain(r.username);
    }
    for (const reason of new Set(REASONS)) expect(everything.toLowerCase()).not.toContain(reason);
    expect(everything).not.toMatch(/\b(three|reporters?|reports?)\b/i);
  });

  it("an anonymised author: no send, and the skip line carries the reason and no address", async () => {
    const a = await createVerifiedActor();
    const postId = await createPublished(a);
    const email = `deleted-${a.userId}@invalid.thinkersjournal.local`;
    await run((c) => c.query(`UPDATE users SET email = $2, anonymised_at = now() WHERE id = $1`, [a.userId, email]));
    const info = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await reportN({ postId }, 0, 3);
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
    expect(sent).toHaveLength(0);
    const skipped = info.mock.calls.filter((c) => c[0] === "moderation notice skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]![1]).toEqual({ reason: "auto_hide_author_anonymised", subject: "post" });
    expect(JSON.stringify(info.mock.calls)).not.toContain(email);
  });

  it("a tombstoned comment: no send", async () => {
    const postId = await createPublished(author);
    const commentId = await createComment(author, postId);
    await run((c) => c.query(`UPDATE comments SET deleted_at = now(), body_markdown = '' WHERE id = $1`, [commentId]));
    const info = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await reportN({ commentId }, 0, 3);
    expect(sent).toHaveLength(0);
    const skipped = info.mock.calls.filter((c) => c[0] === "moderation notice skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]![1]).toEqual({ reason: "auto_hide_comment_deleted", subject: "comment" });
  });

  it("the recipient is read AT SEND TIME: a comment deleted between the hide and the send is not mailed", async () => {
    const postId = await createPublished(author);
    const commentId = await createComment(author, postId);
    await reportN({ commentId }, 0, 2);
    // Runs inside the purge, i.e. after the hide has been written and before the send.
    betweenHideAndSend = async () => {
      await run((c) => c.query(`UPDATE comments SET deleted_at = now(), body_markdown = '' WHERE id = $1`, [commentId]));
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await reportN({ commentId }, 2, 1);
    expect(await hiddenAtOf("comments", commentId)).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("HTML-escapes the author's own title in the notice (post and comment parent)", async () => {
    const title = 'A <b>&"x"</b>';
    const postId = await createPublished(author);
    await run((c) => c.query(`UPDATE posts SET title = $2 WHERE id = $1`, [postId, title]));
    // Before the post is hidden: a comment cannot be created on hidden content.
    const commentId = await createComment(author, postId);
    await reportN({ postId }, 0, 3);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain("&lt;b&gt;");
    expect(sent[0]!.html).toContain("&amp;");
    expect(sent[0]!.html).not.toContain("<b>");

    await reportN({ commentId }, 0, 3);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.html).toContain("&lt;b&gt;");
    expect(sent[1]!.html).toContain("&amp;");
    expect(sent[1]!.html).not.toContain("<b>");
  });

  it("an anonymised author's COMMENT: no send, skip line", async () => {
    const a = await createVerifiedActor();
    const postId = await createPublished(a);
    const commentId = await createComment(a, postId);
    await run((c) =>
      c.query(`UPDATE users SET email = $2, anonymised_at = now() WHERE id = $1`, [
        a.userId,
        `deleted-${a.userId}@invalid.thinkersjournal.local`,
      ]),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await reportN({ commentId }, 0, 3);
    expect(await hiddenAtOf("comments", commentId)).not.toBeNull();
    expect(sent).toHaveLength(0);
    const skipped = warn.mock.calls.filter((c) => c[0] === "moderation notice skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]![1]).toEqual({ reason: "auto_hide_author_anonymised", subject: "comment" });
  });

  it("content restored between the hide and the send: no send (auto_hide_no_longer_hidden)", async () => {
    const postId = await createPublished(author);
    await reportN({ postId }, 0, 2);
    betweenHideAndSend = async () => {
      await run((c) => c.query(`UPDATE posts SET hidden_at = NULL WHERE id = $1`, [postId]));
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await reportN({ postId }, 2, 1);
    expect(sent).toHaveLength(0);
    const skipped = warn.mock.calls.filter((c) => c[0] === "moderation notice skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]![1]).toEqual({ reason: "auto_hide_no_longer_hidden", subject: "post" });
  });

  it("content hard-deleted between the hide and the send: no send (auto_hide_content_gone)", async () => {
    const a = await createVerifiedActor();
    const postId = await createPublished(a);
    await reportN({ postId }, 0, 2);
    betweenHideAndSend = async () => {
      await run((c) => c.query(`DELETE FROM posts WHERE id = $1`, [postId]));
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await reportN({ postId }, 2, 1);
    expect(sent).toHaveLength(0);
    const skipped = warn.mock.calls.filter((c) => c[0] === "moderation notice skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]![1]).toEqual({ reason: "auto_hide_content_gone", subject: "post" });
  });

  it("a Postmark transport REJECTION (fetch throws) never fails the report", async () => {
    const postId = await createPublished(author);
    const inner = globalThis.fetch;
    let threw = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.postmarkapp.com/email" && threw === 0) {
        threw++;
        throw new TypeError("network down");
      }
      return inner(input, init);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await reportN({ postId }, 0, 3);
    expect(threw).toBe(1);
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
  });

  it("the send is off the response path: the report resolves BEFORE a slow Postmark settles", async () => {
    const postId = await createPublished(author);
    await reportN({ postId }, 0, 2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let settled = false;
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.postmarkapp.com/email") {
        await gate;
        settled = true;
      }
      return inner(input, init);
    });
    const web = { fetch: async () => new Response("{}", { status: 200 }) };
    const ctx = createExecutionContext();
    const pending = worker.fetch(
      new Request("https://api.test/reports", {
        method: "POST",
        headers: {
          Origin: ALLOWED_ORIGIN, Cookie: reporters[2]!.cookie, "X-CSRF-Token": reporters[2]!.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ postId, reason: "spam" }),
      }),
      { ...env, WEB: web } as never,
      ctx,
    );
    const first = await Promise.race([
      pending,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 4000)),
    ]);
    const settledWhenResolved = settled;
    release();
    await waitOnExecutionContext(ctx);
    expect(first).not.toBe("timeout");
    expect((first as Response).status).toBe(201);
    expect(settledWhenResolved).toBe(false);
  });

  it("a failing send-time read never throws out of the notice (it is a waitUntil)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const broken = { ...env, HYPERDRIVE_FRESH: { connectionString: "postgres://nobody:nope@127.0.0.1:1/none" } };
    await expect(
      notifyAutoHidden(broken as never, ctx, { purge: { kind: "comment", postId: crypto.randomUUID() }, subject: "comment", subjectId: crypto.randomUUID() }),
    ).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
    expect(sent).toHaveLength(0);
  });

  it("a Postmark failure never fails the report", async () => {
    const postId = await createPublished(author);
    postmarkStatus = 500;
    await reportN({ postId }, 0, 3);
    expect(sent).toHaveLength(1);
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
  });
});
