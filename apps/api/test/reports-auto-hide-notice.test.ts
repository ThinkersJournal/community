// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * T3 of the moderation author-notices design (#56), through the notice outbox (S12):
 * an AUTO-HIDE queues a notice, in the hide's own transaction, telling the author
 * their content is hidden pending review.
 *
 * ⚠️ WHAT THE NOTICE MAY NEVER CARRY (asserted over the full text AND html):
 * a reporter's identity, a report reason, or the number of reports. The
 * threshold is not disclosed either: disclosing it hands an attacker the number.
 *
 * ⚠️ NO APPEAL LINK. The auto-hide row (#57) is not a decision and is not appealable, and an appeal
 * attaches to a decision; the later decision notice carries the link.
 *
 * ⚠️ NOTHING IS SENT BY THE REPORT ROUTE ANY MORE. The row is the record; the outbox drain
 * delivers it (notice-outbox tests). So these tests read the queued row, never a mail.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

const ALLOWED_ORIGIN = "http://localhost:8787";

interface Queued {
  readonly recipient_user_id: string | null;
  readonly subject: string;
  readonly body_text: string;
  readonly body_html: string;
  readonly state: string;
}

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

/** The `author_auto_hide` rows queued for a post or a comment. */
async function queued(target: { postId: string } | { commentId: string }): Promise<Queued[]> {
  const column = "postId" in target ? "post_id" : "comment_id";
  const id = "postId" in target ? target.postId : target.commentId;
  return run(async (c) => {
    const { rows } = await c.query<Queued>(
      `SELECT o.recipient_user_id, o.subject, o.body_text, o.body_html, o.state
         FROM moderation_notice_outbox o JOIN moderation_actions ma ON ma.id = o.action_id
        WHERE o.kind = 'author_auto_hide' AND ma.${column} = $1`,
      [id],
    );
    return rows;
  });
}

let mailed = 0;

beforeEach(() => {
  mailed = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://api.postmarkapp.com/email") mailed += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function report(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const web = { fetch: async () => new Response(JSON.stringify({ purged: 1 }), { status: 200 }) };
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

async function anonymise(userId: string): Promise<void> {
  await run((c) =>
    c.query(`UPDATE users SET email = $2, anonymised_at = now() WHERE id = $1`, [
      userId,
      `deleted-${userId}@invalid.thinkersjournal.local`,
    ]),
  );
}

/** A link of any shape: a scheme, an href, the `/appeal` PATH, or its token parameter. The bare word "appeal" is copy, not a link. */
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

function expectPendingReviewCopy(m: Queued): void {
  expect(m.body_text).toContain("pending review");
  expect(m.body_html).toContain("pending review");
  // No appeal link: nothing has been decided, so there is nothing to appeal.
  expect(m.body_text).not.toMatch(NO_LINK);
  expect(m.body_html).not.toMatch(NO_LINK);
  for (const body of [m.body_text, m.body_html]) {
    expect(body).toContain("nothing to appeal yet");
    expect(body).toContain("done automatically");
    expect(body).toContain("how to appeal");
  }
}

describe("auto-hide author notice (#56, S12 outbox)", () => {
  it("queues nothing for reports 1 and 2; the 3rd hides the post AND queues exactly one pending notice for the author, sending nothing itself", async () => {
    const postId = await createPublished(author);

    await reportN({ postId }, 0, 2);
    expect(await queued({ postId })).toHaveLength(0);
    expect(await hiddenAtOf("posts", postId)).toBeNull();

    await reportN({ postId }, 2, 1);
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
    const rows = await queued({ postId });
    expect(rows).toHaveLength(1);
    const m = rows[0]!;
    expect(m.recipient_user_id).toBe(author.userId);
    expect(m.state).toBe("pending");
    expect(m.body_text).toContain(await titleOf(postId));
    expectPendingReviewCopy(m);
    // The report route delivers nothing: the drain does.
    expect(mailed).toBe(0);
  });

  it("a 4th report on already-hidden content queues nothing more", async () => {
    const postId = await createPublished(author);
    await reportN({ postId }, 0, 3);
    expect(await queued({ postId })).toHaveLength(1);
    await reportN({ postId }, 3, 1);
    expect(await queued({ postId })).toHaveLength(1);
  });

  it("a comment: the copy names the parent post and says 'your comment'", async () => {
    const postId = await createPublished(author);
    const commentId = await createComment(author, postId);
    await reportN({ commentId }, 0, 3);
    const rows = await queued({ commentId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient_user_id).toBe(author.userId);
    expect(rows[0]!.body_text).toContain(`your comment on "${await titleOf(postId)}"`);
    expectPendingReviewCopy(rows[0]!);
  });

  it("never carries a reporter's identity, a report reason, or the number of reports", async () => {
    const postId = await createPublished(author);
    await reportN({ postId }, 0, 3);
    const rows = await queued({ postId });
    expect(rows).toHaveLength(1);
    const everything = `${rows[0]!.subject}\n${rows[0]!.body_text}\n${rows[0]!.body_html}`;
    for (const r of reporters.slice(0, 3)) {
      expect(everything).not.toContain(r.userId);
      expect(everything).not.toContain(r.username);
    }
    for (const reason of new Set(REASONS)) expect(everything.toLowerCase()).not.toContain(reason);
    expect(everything).not.toMatch(/\b(three|reporters?|reports?)\b/i);
  });

  it("an anonymised author's post: hidden, nothing queued", async () => {
    const a = await createVerifiedActor();
    const postId = await createPublished(a);
    await anonymise(a.userId);

    await reportN({ postId }, 0, 3);
    expect(await hiddenAtOf("posts", postId)).not.toBeNull();
    expect(await queued({ postId })).toHaveLength(0);
  });

  it("a tombstoned comment: hidden, nothing queued", async () => {
    const postId = await createPublished(author);
    const commentId = await createComment(author, postId);
    await run((c) => c.query(`UPDATE comments SET deleted_at = now(), body_markdown = '' WHERE id = $1`, [commentId]));

    await reportN({ commentId }, 0, 3);
    expect(await hiddenAtOf("comments", commentId)).not.toBeNull();
    expect(await queued({ commentId })).toHaveLength(0);
  });

  it("an anonymised author's COMMENT: hidden, nothing queued", async () => {
    const a = await createVerifiedActor();
    const postId = await createPublished(a);
    const commentId = await createComment(a, postId);
    await anonymise(a.userId);

    await reportN({ commentId }, 0, 3);
    expect(await hiddenAtOf("comments", commentId)).not.toBeNull();
    expect(await queued({ commentId })).toHaveLength(0);
  });

  it("HTML-escapes the author's own title in the notice (post and comment parent)", async () => {
    const title = 'A <b>&"x"</b>';
    const postId = await createPublished(author);
    await run((c) => c.query(`UPDATE posts SET title = $2 WHERE id = $1`, [postId, title]));
    // Before the post is hidden: a comment cannot be created on hidden content.
    const commentId = await createComment(author, postId);
    await reportN({ postId }, 0, 3);
    const post = await queued({ postId });
    expect(post).toHaveLength(1);
    expect(post[0]!.body_html).toContain("&lt;b&gt;");
    expect(post[0]!.body_html).toContain("&amp;");
    expect(post[0]!.body_html).not.toContain("<b>");

    await reportN({ commentId }, 0, 3);
    const comment = await queued({ commentId });
    expect(comment).toHaveLength(1);
    expect(comment[0]!.body_html).toContain("&lt;b&gt;");
    expect(comment[0]!.body_html).toContain("&amp;");
    expect(comment[0]!.body_html).not.toContain("<b>");
  });
});
