// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import { applyDecision } from "../src/moderation/decide";

/**
 * S14(c): a member who used the Report button is told the outcome. The ruling
 * (decide.ts) marks every unanswered report on the content as answered and queues
 * one `member_reporter_outcome` per reporter, in its own transaction.
 */

let userIds: string[] = [];
let actionIds: string[] = [];

async function ctxRun<T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

afterEach(async () => {
  await ctxRun(async (c) => {
    await c.query(`DELETE FROM moderation_notice_outbox WHERE action_id = ANY($1::uuid[])`, [actionIds]);
    await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
  });
  userIds = [];
  actionIds = [];
});

async function seedUser(opts: { anonymised?: boolean } = {}): Promise<string> {
  const id = await ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at, anonymised_at)
       VALUES ($1, 'x', now(), ${opts.anonymised === true ? "now()" : "NULL"}) RETURNING id`,
      [`test-${crypto.randomUUID()}@example.com`],
    );
    return rows[0]!.id;
  });
  userIds.push(id);
  return id;
}

async function seedPost(authorId: string): Promise<{ id: string; title: string }> {
  return ctxRun(async (c) => {
    const title = "reported post " + crypto.randomUUID().slice(0, 8);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, $2, $3, 'body', 'published', now()) RETURNING id`,
      [authorId, title, "t-" + crypto.randomUUID().slice(0, 8)],
    );
    return { id: rows[0]!.id, title };
  });
}

function report(reporterId: string, postId: string): Promise<unknown> {
  return ctxRun((c) =>
    c.query(`INSERT INTO reports (reporter_id, post_id, reason) VALUES ($1, $2, 'spam')`, [reporterId, postId]),
  );
}

async function decide(postId: string, decision: "remove" | "restore" | "keep_hidden", reason = "A private moderator reason."): Promise<string> {
  const result = await ctxRun((c) =>
    applyDecision(c, { subject: "post", subjectId: postId, decision, reason, actorAdmin: "mod@example.test" }),
  );
  const actionId = result!.actionId;
  actionIds.push(actionId);
  return actionId;
}

interface Row { kind: string; recipient_user_id: string | null; body_text: string }
const memberRows = (actionId: string) =>
  ctxRun(async (c) =>
    (await c.query<Row>(
      `SELECT kind, recipient_user_id, body_text FROM moderation_notice_outbox
        WHERE action_id = $1 AND kind = 'member_reporter_outcome' ORDER BY recipient_user_id`,
      [actionId],
    )).rows,
  );
const outcomeOf = (postId: string, reporterId: string) =>
  ctxRun(async (c) =>
    (await c.query<{ outcome_action_id: string | null }>(
      `SELECT outcome_action_id FROM reports WHERE post_id = $1 AND reporter_id = $2`,
      [postId, reporterId],
    )).rows[0]!.outcome_action_id,
  );

describe("member reporter outcome (S14c)", () => {
  it("answers every unanswered member report with a short outcome email and marks the reports answered", async () => {
    const author = await seedUser();
    const r1 = await seedUser();
    const r2 = await seedUser();
    const post = await seedPost(author);
    await report(r1, post.id);
    await report(r2, post.id);

    const actionId = await decide(post.id, "remove");

    const rows = await memberRows(actionId);
    expect(rows.map((r) => r.recipient_user_id).sort()).toEqual([r1, r2].sort());
    for (const r of rows) {
      expect(r.body_text).toContain("removed it");
      expect(r.body_text).toContain(post.title);
      // The moderator's reason is a statement to the author; a member reporter gets the outcome only.
      expect(r.body_text).not.toContain("A private moderator reason.");
    }
    expect(await outcomeOf(post.id, r1)).toBe(actionId);
    expect(await outcomeOf(post.id, r2)).toBe(actionId);
  });

  it("answers a report once: a later ruling emails only reports it newly answers", async () => {
    const author = await seedUser();
    const r1 = await seedUser();
    const r2 = await seedUser();
    const post = await seedPost(author);
    await report(r1, post.id);
    const first = await decide(post.id, "remove");
    expect(await memberRows(first)).toHaveLength(1);

    await report(r2, post.id);
    const second = await decide(post.id, "restore");
    const rows = await memberRows(second);
    expect(rows.map((r) => r.recipient_user_id)).toEqual([r2]);
    expect(rows[0]!.body_text).toContain("no action was taken");
    // r1's report keeps the ruling that answered it.
    expect(await outcomeOf(post.id, r1)).toBe(first);
  });

  it("marks an anonymised reporter's report answered but queues nothing for them", async () => {
    const author = await seedUser();
    const gone = await seedUser({ anonymised: true });
    const live = await seedUser();
    const post = await seedPost(author);
    await report(gone, post.id);
    await report(live, post.id);

    const actionId = await decide(post.id, "keep_hidden");

    expect((await memberRows(actionId)).map((r) => r.recipient_user_id)).toEqual([live]);
    expect(await outcomeOf(post.id, gone)).toBe(actionId);
  });

  it("queues nothing when no member reported the content", async () => {
    const author = await seedUser();
    const post = await seedPost(author);
    const actionId = await decide(post.id, "remove");
    expect(await memberRows(actionId)).toHaveLength(0);
  });
});
