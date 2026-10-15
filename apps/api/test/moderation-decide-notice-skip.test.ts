/**
 * T1 of the moderation author-notices design (#138, #135): `applyDecision`
 * reports, from the SAME row its UPDATE wrote, whether an author notice has
 * anyone to go to (`noticeSkip`).
 *
 * ⚠️ `authorEmail` is asserted populated in every case. A "skip" must mean
 * "there is a row and it is not noticeable", never "no row": the audit row's
 * `subjectLabel` still needs the address, so the field stays on the result.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { withClient } from "../src/db/client";
import { applyDecision, type DecisionKind } from "../src/moderation/decide";

import type { Client } from "pg";

let userIds: string[] = [];

async function run<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const v = await withClient(env.HYPERDRIVE_FRESH, ctx, fn);
  await waitOnExecutionContext(ctx);
  return v;
}

async function seedAuthor(anonymised: boolean): Promise<string> {
  return run(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, 'x', now()) RETURNING id`,
      [`decide-skip-${crypto.randomUUID()}@example.com`],
    );
    const id = rows[0]!.id;
    userIds.push(id);
    if (anonymised) {
      // The real scrub's shape (auth/anonymise-accounts.ts): sentinel address + anonymised_at.
      await c.query(`UPDATE users SET email = $2, anonymised_at = now() WHERE id = $1`, [
        id,
        `deleted-${id}@invalid.thinkersjournal.local`,
      ]);
    }
    return id;
  });
}

async function seedPost(authorId: string): Promise<string> {
  return run(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 'skip test', $2, 'body', 'published', now()) RETURNING id`,
      [authorId, `skip-${crypto.randomUUID().slice(0, 8)}`],
    );
    return rows[0]!.id;
  });
}

async function seedComment(authorId: string, postId: string, tombstoned: boolean): Promise<string> {
  return run(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `WITH ids AS (SELECT uuidv7() AS id)
       INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown, deleted_at)
       SELECT ids.id, $1, $2, NULL, ids.id::text, 0, $3, CASE WHEN $4::boolean THEN now() ELSE NULL END FROM ids
       RETURNING id`,
      [postId, authorId, tombstoned ? "" : "a comment", tombstoned],
    );
    return rows[0]!.id;
  });
}

function decide(subject: "post" | "comment", subjectId: string, decision: DecisionKind) {
  return run((c) => applyDecision(c, { subject, subjectId, decision, reason: "r", actorAdmin: "mod@test" }));
}

afterEach(async () => {
  if (userIds.length === 0) return;
  const ids = userIds;
  userIds = [];
  await run(async (c) => {
    await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
  });
});

describe("applyDecision noticeSkip (#138, #135)", () => {
  it("a live post by a live author: null", async () => {
    const post = await seedPost(await seedAuthor(false));
    const r = await decide("post", post, "remove");
    expect(r?.noticeSkip).toBeNull();
    expect(r?.authorEmail).toMatch(/^decide-skip-/);
  });

  it("a live comment by a live author: null", async () => {
    const a = await seedAuthor(false);
    const comment = await seedComment(a, await seedPost(a), false);
    const r = await decide("comment", comment, "keep_hidden");
    expect(r?.noticeSkip).toBeNull();
  });

  it("a post by an anonymised author: author_anonymised, address still on the result", async () => {
    const a = await seedAuthor(true);
    const r = await decide("post", await seedPost(a), "remove");
    expect(r?.noticeSkip).toBe("author_anonymised");
    expect(r?.authorEmail).toBe(`deleted-${a}@invalid.thinkersjournal.local`);
  });

  it("a comment by an anonymised author: author_anonymised", async () => {
    const a = await seedAuthor(true);
    const r = await decide("comment", await seedComment(a, await seedPost(a), false), "remove");
    expect(r?.noticeSkip).toBe("author_anonymised");
    expect(r?.authorEmail).toMatch(/@invalid\.thinkersjournal\.local$/);
  });

  it("a tombstoned comment by a live author: comment_deleted, address still on the result", async () => {
    const a = await seedAuthor(false);
    const r = await decide("comment", await seedComment(a, await seedPost(a), true), "remove");
    expect(r?.noticeSkip).toBe("comment_deleted");
    expect(r?.authorEmail).toMatch(/^decide-skip-/);
  });

  it("a tombstoned comment by an anonymised author: author_anonymised wins", async () => {
    const a = await seedAuthor(true);
    const r = await decide("comment", await seedComment(a, await seedPost(a), true), "remove");
    expect(r?.noticeSkip).toBe("author_anonymised");
  });

  it.each(["restore", "keep_hidden", "remove"] as const)("the flag does not depend on the decision (%s)", async (decision) => {
    const a = await seedAuthor(true);
    const r = await decide("post", await seedPost(a), decision);
    expect(r?.noticeSkip).toBe("author_anonymised");
    const b = await seedAuthor(false);
    const c2 = await decide("comment", await seedComment(b, await seedPost(b), true), decision);
    expect(c2?.noticeSkip).toBe("comment_deleted");
  });
});
