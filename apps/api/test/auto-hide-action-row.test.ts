/**
 * DSA Art. 17 / #57 (CireSnave Q4=B): an AUTO-HIDE appends a `moderation_actions`
 * row — actor 'system', kind `content_auto_hide` — and that row is an AUDIT
 * FACT, NOT A HUMAN RULING.
 *
 * Two halves, deliberately:
 *   1. the row is written (and written ONCE, with a fixed reason);
 *   2. every reader that used `action LIKE 'content\_%'` to mean "a moderator
 *      ruled" still means exactly that — the new row changes none of them.
 *
 * ⚠️ MUTATION EACH GUARD MUST FAIL UNDER (named per describe block): put
 * `content_auto_hide` into HUMAN_CONTENT_RULING_KINDS
 * (src/moderation/visibility-actions.ts), or revert that reader to
 * `action LIKE 'content\_%'`. Every test marked ⚠️ below asserts something that
 * flips under that single change.
 *
 * Some scenarios (an auto-hide row NEWER than a human ruling while the content
 * is still hidden) cannot arise through the real flow — auto-hide only fires on
 * `hidden_at IS NULL`, and a human ruling that hid it was reversed by a restore
 * first. They are seeded raw on purpose: the list filter, not the flow, is the
 * guard being pinned.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { fileAppeal, describeAppealTarget, resolveAppeal } from "../src/moderation/appeals";
import { AUTO_HIDE_ACTION_REASON, AUTO_HIDE_REPORTER_THRESHOLD, maybeAutoHide } from "../src/moderation/auto-hide";
import { applyDecision } from "../src/moderation/decide";
import { unhidePost, hidePost } from "../src/moderation/author-hide";
import { hiddenReasonCaseSql } from "../src/moderation/hidden-reason";
import { listOpenQueue } from "../src/moderation/queue";
import { APPEALABLE_ACTIONS } from "@thinkersjournal/shared";
import { createPublished, createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";
import type { Client } from "pg";

const ALLOWED_ORIGIN = "http://localhost:8787";

async function ctxRun<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

afterEach(async () => {
  // moderation_actions is append-only (0013): its rows are left in place; each
  // test uses fresh post/comment ids, so leftovers cannot match a later run.
  await deleteCreatedUsers();
});

async function reportTarget(target: { postId: string } | { commentId: string }, n: number, minutesAgo = 0): Promise<void> {
  for (let i = 0; i < n; i++) {
    const reporter = await createVerifiedActor();
    await ctxRun((c) =>
      c.query(
        `INSERT INTO reports (reporter_id, post_id, comment_id, reason, created_at)
         VALUES ($1, $2, $3, 'spam', now() - ($4 || ' minutes')::interval)`,
        [
          reporter.userId,
          "postId" in target ? target.postId : null,
          "commentId" in target ? target.commentId : null,
          String(minutesAgo),
        ],
      ),
    );
  }
}

async function seedComment(authorId: string, postId: string): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `WITH ids AS (SELECT uuidv7() AS id)
       INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown)
       SELECT ids.id, $1, $2, NULL, ids.id::text, 0, 'a comment' FROM ids
       RETURNING id`,
      [postId, authorId],
    );
    return rows[0]!.id;
  });
}

interface ActionRow {
  id: string;
  actor_admin: string;
  action: string;
  post_id: string | null;
  comment_id: string | null;
  subject_user_id: string | null;
  subject_label: string | null;
  violation_category: string | null;
  action_expires_at: Date | null;
  reason: string;
  internal_note: string | null;
}

async function rowsFor(column: "post_id" | "comment_id", id: string): Promise<ActionRow[]> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<ActionRow>(
      `SELECT id, actor_admin, action, post_id, comment_id, subject_user_id, subject_label,
              violation_category, action_expires_at, reason, internal_note
         FROM moderation_actions WHERE ${column} = $1 ORDER BY created_at, id`,
      [id],
    );
    return rows;
  });
}

async function seedAutoHideRow(postId: string, userId: string): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO moderation_actions (actor_admin, action, post_id, subject_user_id, reason)
       VALUES ('system', 'content_auto_hide', $1, $2, $3) RETURNING id`,
      [postId, userId, AUTO_HIDE_ACTION_REASON],
    );
    return rows[0]!.id;
  });
}

async function seedRuling(postId: string, userId: string, action: string, createdAt?: Date): Promise<string> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO moderation_actions (actor_admin, action, post_id, subject_user_id, reason, created_at)
       VALUES ('mod@example.test', $1, $2, $3, 'r', COALESCE($4, now())) RETURNING id`,
      [action, postId, userId, createdAt ?? null],
    );
    return rows[0]!.id;
  });
}

const hide = (postId: string): Promise<void> => ctxRun((c) => c.query(`UPDATE posts SET hidden_at = now() WHERE id = $1`, [postId]).then(() => undefined));

async function hiddenAt(table: "posts" | "comments", id: string): Promise<Date | null> {
  return ctxRun(async (c) => (await c.query<{ h: Date | null }>(`SELECT hidden_at AS h FROM ${table} WHERE id = $1`, [id])).rows[0]!.h);
}

async function queueHas(targetId: string): Promise<boolean> {
  const items = await ctxRun((c) => listOpenQueue(c, 1_000_000));
  return items.some((i) => i.targetId === targetId);
}

async function hiddenReasonOf(postId: string): Promise<string | null> {
  return ctxRun(async (c) => {
    const { rows } = await c.query<{ r: string | null }>(
      `SELECT ${hiddenReasonCaseSql("p.id", "p.hidden_at")} AS r FROM posts p WHERE p.id = $1`,
      [postId],
    );
    return rows[0]!.r;
  });
}

async function forPost(actor: Actor, postId: string): Promise<{ actionId: string } | null> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://api.test/appeals/for-post/${postId}`, {
      headers: { Origin: ALLOWED_ORIGIN, Cookie: actor.cookie, "X-CSRF-Token": actor.csrfToken },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return ((await res.json()) as { target: { actionId: string } | null }).target;
}

// ---- 1. the row ------------------------------------------------------------------

describe("#57 — an auto-hide appends one system-actor row", () => {
  it("post: exactly one content_auto_hide row, actor 'system', fixed reason, subject filled like decide.ts, no category", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD);

    const result = await ctxRun((c) => maybeAutoHide(c, { postId }));
    expect(result).not.toBeNull();
    expect(await hiddenAt("posts", postId)).not.toBeNull();

    const rows = await rowsFor("post_id", postId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_admin: "system",
      action: "content_auto_hide",
      post_id: postId,
      comment_id: null,
      subject_user_id: author.userId,
      violation_category: null,
      action_expires_at: null,
      reason: AUTO_HIDE_ACTION_REASON,
      internal_note: null,
    });
    // subject_label is the author's address, exactly as decide.ts stores it.
    const { rows: u } = await ctxRun((c) => c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [author.userId]));
    expect(rows[0]!.subject_label).toBe(u[0]!.email);
  });

  it("⚠️ the fixed reason carries no reporter identity, count or threshold", async () => {
    // Guards the constant itself: a future "helpful" edit that interpolates the
    // reports would fail here.
    expect(AUTO_HIDE_ACTION_REASON).not.toMatch(/\d/);
    expect(AUTO_HIDE_ACTION_REASON).not.toMatch(/@|report|threshold|reporter/i);
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD);
    await ctxRun((c) => maybeAutoHide(c, { postId }));
    expect((await rowsFor("post_id", postId))[0]!.reason).toBe(AUTO_HIDE_ACTION_REASON);
  });

  it("comment: the row carries comment_id, not post_id", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const commentId = await seedComment(author.userId, postId);
    await reportTarget({ commentId }, AUTO_HIDE_REPORTER_THRESHOLD);

    expect(await ctxRun((c) => maybeAutoHide(c, { commentId }))).not.toBeNull();

    const rows = await rowsFor("comment_id", commentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_admin: "system",
      action: "content_auto_hide",
      comment_id: commentId,
      post_id: null,
      subject_user_id: author.userId,
    });
  });

  it("CONTROL: below the threshold nothing is hidden and no row is written", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD - 1);

    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).toBeNull();
    expect(await hiddenAt("posts", postId)).toBeNull();
    expect(await rowsFor("post_id", postId)).toEqual([]);
  });

  it("⚠️ idempotent: a further report on already-hidden content hides nothing and writes NO second row", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD);
    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).not.toBeNull();
    const stamped = await hiddenAt("posts", postId);

    await reportTarget({ postId }, 1);
    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).toBeNull();

    expect(await rowsFor("post_id", postId)).toHaveLength(1);
    expect((await hiddenAt("posts", postId))?.getTime()).toBe(stamped!.getTime());
    // Mutation: drop the `row === undefined` early return (or write the row
    // before the UPDATE) and this is 2.
  });

  it("already hidden at the threshold: no hide, no row, and the client is left OUTSIDE a transaction (ROLLBACK ran)", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD);
    await hide(postId);
    await ctxRun(async (c) => {
      expect(await maybeAutoHide(c, { postId })).toBeNull();
      // BEGIN_BOUNDED_TX's SET LOCAL reverts to the session default only once
      // the transaction has ended.
      const { rows } = await c.query<{ t: string }>(`SELECT current_setting('idle_in_transaction_session_timeout') AS t`);
      expect(rows[0]!.t).toBe("0");
    });
    expect(await rowsFor("post_id", postId)).toEqual([]);
  });
});

// ---- 2. readers: the row is NOT a human ruling -----------------------------------

describe("⚠️ #57 reader — auto-hide's own report cut-off (auto-hide.ts)", () => {
  it("reports that PREDATE an auto-hide row still count: the row is not a ruling", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD, 60);
    await seedAutoHideRow(postId, author.userId); // newer than every report; post not hidden

    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).not.toBeNull();
    // Mutation: LIKE 'content\_%' (or adding the kind to the human list) makes
    // the cut-off `now`, the count 0, and this null.
  });

  it("CONTROL: the same shape with a human content_restore row DOES reset the count (issue #55)", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD, 60);
    await seedRuling(postId, author.userId, "content_restore");

    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).toBeNull();
    expect(await hiddenAt("posts", postId)).toBeNull();
  });
});

describe("⚠️ #57 reader — the moderation queue (queue.ts) keeps an auto-hidden item OPEN", () => {
  it("a real auto-hide leaves the reported post in the open queue for a human", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD);
    await ctxRun((c) => maybeAutoHide(c, { postId }));
    expect(await rowsFor("post_id", postId)).toHaveLength(1);

    expect(await queueHas(postId)).toBe(true);
    // Mutation: LIKE 'content\_%' in either NOT EXISTS makes this false.
  });

  it("a comment auto-hide likewise stays open (the comment_ruled / comment NOT EXISTS arms)", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const commentId = await seedComment(author.userId, postId);
    await reportTarget({ commentId }, AUTO_HIDE_REPORTER_THRESHOLD);
    await ctxRun((c) => maybeAutoHide(c, { commentId }));

    expect(await queueHas(commentId)).toBe(true);
  });

  it("oldestReportAt ignores the auto-hide row (#119's ruled_at CTE): it is still the first report", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD, 90);
    await seedAutoHideRow(postId, author.userId);

    const items = await ctxRun((c) => listOpenQueue(c, 1_000_000));
    const mine = items.find((i) => i.targetId === postId);
    expect(mine).toBeDefined();
    // The oldest report is ~90 minutes old; with the row counted as a ruling it
    // would be NULL/absent (every report older than the ruling is "ruled").
    expect(Date.now() - new Date(mine!.oldestReportAt).getTime()).toBeGreaterThan(80 * 60_000);
  });

  it("CONTROL: a human keep_hidden after the auto-hide closes the item", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD);
    await ctxRun((c) => maybeAutoHide(c, { postId }));
    expect(await queueHas(postId)).toBe(true);

    await ctxRun((c) =>
      applyDecision(c, { subject: "post", subjectId: postId, decision: "keep_hidden", reason: "r", actorAdmin: "mod@example.test" }),
    );
    expect(await queueHas(postId)).toBe(false);
  });
});

describe("⚠️ #57 readers — appeals (appeals.ts, routes/appeals.ts, shared APPEALABLE_ACTIONS)", () => {
  it("content_auto_hide is not an appealable kind", () => {
    expect(APPEALABLE_ACTIONS as readonly string[]).not.toContain("content_auto_hide");
  });

  it("fileAppeal on an auto-hide row is not_appealable, and describeAppealTarget answers null", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await hide(postId);
    const actionId = await seedAutoHideRow(postId, author.userId);

    const out = await ctxRun((c) => fileAppeal(c, { actionId, appellantId: author.userId, body: "x" }));
    expect(out).toEqual({ kind: "not_appealable" });
    expect(await ctxRun((c) => describeAppealTarget(c, actionId))).toBeNull();
  });

  it("/appeals/for-post: a post hidden only by an auto-hide row → target null", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD);
    await ctxRun((c) => maybeAutoHide(c, { postId }));

    expect(await forPost(author, postId)).toBeNull();
  });

  it("⚠️ /appeals/for-post: a human keep_hidden is still the governing decision when an auto-hide row is the NEWER row", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await hide(postId);
    const keepId = await seedRuling(postId, author.userId, "content_keep_hidden", new Date(Date.now() - 3600_000));
    await seedAutoHideRow(postId, author.userId);

    const target = await forPost(author, postId);
    expect(target?.actionId).toBe(keepId);
    // Mutation: LIKE 'content\_%' makes the latest row the auto-hide → null.
  });

  it("/appeals/for-post: keep_hidden → restore → auto-hide → target null (restore governs)", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await seedRuling(postId, author.userId, "content_keep_hidden", new Date(Date.now() - 7200_000));
    await seedRuling(postId, author.userId, "content_restore", new Date(Date.now() - 3600_000));
    await hide(postId);
    await seedAutoHideRow(postId, author.userId);

    expect(await forPost(author, postId)).toBeNull();
  });

  it("⚠️ D1: an auto-hide row newer than the appealed decision does NOT supersede it — the grant restores", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    const removeId = await ctxRun(async (c) => {
      const r = await applyDecision(c, { subject: "post", subjectId: postId, decision: "remove", reason: "r", actorAdmin: "mod@example.test" });
      return r!.actionId;
    });
    const filed = await ctxRun((c) => fileAppeal(c, { actionId: removeId, appellantId: author.userId, body: "no" }));
    if (filed.kind !== "filed") throw new Error(`seed appeal failed: ${filed.kind}`);
    await seedAutoHideRow(postId, author.userId); // newer, raw (see header)

    const out = await ctxRun((c) =>
      resolveAppeal(c, { appealId: filed.appealId, grant: true, reason: "upheld", actorAdmin: "mod2@example.test" }),
    );
    expect(out.kind).toBe("resolved");
    expect(await hiddenAt("posts", postId)).toBeNull();
    // Mutation: LIKE 'content\_%' in the D1 check → { kind: "superseded" }.
  });
});

describe("⚠️ #57 readers — hiddenReason and the author's unhide gate (hidden-reason.ts, author-hide.ts, visibility-actions.ts)", () => {
  it("an auto-hidden post reads hiddenReason 'moderation' and the author cannot unhide it", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD);
    await ctxRun((c) => maybeAutoHide(c, { postId }));

    expect(await hiddenReasonOf(postId)).toBe("moderation");
    expect(await ctxRun((c) => unhidePost(c, postId, author.userId))).toMatchObject({ kind: "under_moderation" });
    expect(await ctxRun((c) => hidePost(c, postId, author.userId))).toMatchObject({ kind: "under_moderation" });
    expect(await hiddenAt("posts", postId)).not.toBeNull();
  });

  it("⚠️ author_hide → author_unhide → auto-hide stays 'moderation' (the auto-hide row must not read as the author's)", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    expect(await ctxRun((c) => hidePost(c, postId, author.userId))).toMatchObject({ kind: "hidden" });
    expect(await ctxRun((c) => unhidePost(c, postId, author.userId))).toMatchObject({ kind: "unhidden" });
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD);
    await ctxRun((c) => maybeAutoHide(c, { postId }));

    expect(await hiddenReasonOf(postId)).toBe("moderation");
    expect(await ctxRun((c) => unhidePost(c, postId, author.userId))).toMatchObject({ kind: "under_moderation" });
  });

  it("CONTROL: an author's own hide still reads 'author'", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await ctxRun((c) => hidePost(c, postId, author.userId));
    expect(await hiddenReasonOf(postId)).toBe("author");
  });
});

// ---- 3. a human decision after an auto-hide is unchanged -------------------------

describe("#57 — a human decision after an auto-hide behaves exactly as before", () => {
  it("keep_hidden keeps the ORIGINAL hidden_at, appends its own row, and is the appeal target", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD);
    await ctxRun((c) => maybeAutoHide(c, { postId }));
    const stamped = await hiddenAt("posts", postId);

    const decided = await ctxRun((c) =>
      applyDecision(c, { subject: "post", subjectId: postId, decision: "keep_hidden", reason: "r", actorAdmin: "mod@example.test" }),
    );
    expect(decided).not.toBeNull();
    expect(decided!.wasHidden).toBe(true);
    expect((await hiddenAt("posts", postId))?.getTime()).toBe(stamped!.getTime());
    expect((await rowsFor("post_id", postId)).map((r) => [r.actor_admin, r.action])).toEqual([
      ["system", "content_auto_hide"],
      ["mod@example.test", "content_keep_hidden"],
    ]);
    expect((await forPost(author, postId))?.actionId).toBe(decided!.actionId);
    const filed = await ctxRun((c) => fileAppeal(c, { actionId: decided!.actionId, appellantId: author.userId, body: "x" }));
    expect(filed.kind).toBe("filed");
  });

  it("restore unhides it; later reports then re-hide it and write a SECOND auto-hide row (one per hide event)", async () => {
    const author = await createVerifiedActor();
    const postId = await createPublished(author);
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD);
    await ctxRun((c) => maybeAutoHide(c, { postId }));
    await ctxRun((c) =>
      applyDecision(c, { subject: "post", subjectId: postId, decision: "restore", reason: "r", actorAdmin: "mod@example.test" }),
    );
    expect(await hiddenAt("posts", postId)).toBeNull();

    // The three earlier reports are before the restore: they no longer count.
    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).toBeNull();
    await reportTarget({ postId }, AUTO_HIDE_REPORTER_THRESHOLD);
    expect(await ctxRun((c) => maybeAutoHide(c, { postId }))).not.toBeNull();

    expect((await rowsFor("post_id", postId)).map((r) => r.action)).toEqual([
      "content_auto_hide",
      "content_restore",
      "content_auto_hide",
    ]);
  });
});
