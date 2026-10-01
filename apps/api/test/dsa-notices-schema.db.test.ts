import { Client } from "pg";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;

async function makeUser(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`dsa-notices-${crypto.randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}

async function makePost(authorId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
     VALUES ($1, 't', $2, 'b', 'published', now()) RETURNING id`,
    [authorId, `s-${crypto.randomUUID()}`],
  );
  return rows[0]!.id;
}

function tokenHash(): string {
  return `h-${crypto.randomUUID()}`;
}

async function insertNotice(overrides: Partial<{
  reporterEmail: string;
  reporterName: string;
  goodFaith: boolean;
  verifyTokenHash: string;
  targetKind: string;
  targetLabel: string;
  postId: string | null;
  commentId: string | null;
  reason: string;
  statement: string;
}> = {}): Promise<string> {
  const opts = {
    reporterEmail: `notice-${crypto.randomUUID()}@example.com`,
    reporterName: "Jane Reporter",
    goodFaith: true,
    verifyTokenHash: tokenHash(),
    // Addendum (PM ruling, 2026-10-01): target_kind/target_label are NOT NULL
    // as of migration 0020's SET NULL ruling. Defaults match the common
    // postId-only case below; a comment-target case overrides both.
    targetKind: "post",
    targetLabel: "a target label",
    postId: null as string | null,
    commentId: null as string | null,
    reason: "spam",
    statement: "This infringes my copyright.",
    ...overrides,
  };
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO dsa_notices
       (reporter_email, reporter_name, good_faith, verify_token_hash,
        target_kind, target_label, post_id, comment_id, reason, statement)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      opts.reporterEmail,
      opts.reporterName,
      opts.goodFaith,
      opts.verifyTokenHash,
      opts.targetKind,
      opts.targetLabel,
      opts.postId,
      opts.commentId,
      opts.reason,
      opts.statement,
    ],
  );
  return rows[0]!.id;
}

const createdUserIds: string[] = [];

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterEach(async () => {
  if (createdUserIds.length > 0) {
    // Deleting users cascades posts and, via the new FK, dsa_notices.
    await client.query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
    createdUserIds.length = 0;
  }
});

afterAll(async () => {
  await client.end();
});

describe("dsa_notices schema", () => {
  it("rejects a row with both post_id and comment_id set (dsa_notices_one_target)", async () => {
    const author = await makeUser();
    createdUserIds.push(author);
    const postId = await makePost(author);
    const { rows: commentRows } = await client.query<{ id: string }>(
      `WITH ids AS (SELECT uuidv7() AS id)
       INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown)
       SELECT ids.id, $1, $2, NULL, ids.id::text, 0, 'hello'
         FROM ids
       RETURNING id`,
      [postId, author],
    );
    const commentId = commentRows[0]!.id;

    await expect(
      insertNotice({ postId, commentId }),
    ).rejects.toMatchObject({ code: "23514", constraint: "dsa_notices_one_target" });
  });

  it("rejects target_kind='post' with comment_id set (dsa_notices_one_target)", async () => {
    const author = await makeUser();
    createdUserIds.push(author);
    const postId = await makePost(author);
    const { rows: commentRows } = await client.query<{ id: string }>(
      `WITH ids AS (SELECT uuidv7() AS id)
       INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown)
       SELECT ids.id, $1, $2, NULL, ids.id::text, 0, 'hello'
         FROM ids
       RETURNING id`,
      [postId, author],
    );
    const commentId = commentRows[0]!.id;

    await expect(
      insertNotice({ targetKind: "post", postId: null, commentId }),
    ).rejects.toMatchObject({ code: "23514", constraint: "dsa_notices_one_target" });
  });

  /**
   * ⚠️ Addendum (PM ruling, 2026-10-01): this is NO LONGER a rejection case.
   * `dsa_notices_one_target` only checks the OTHER kind's column is NULL —
   * `target_kind = 'post' AND comment_id IS NULL` never requires `post_id`
   * itself to be set — because `post_id` legitimately goes to NULL once the
   * FK's `ON DELETE SET NULL` fires (an orphaned notice). The old test here
   * asserted a rejection that the schema change deliberately removes; this
   * replaces it with the acceptance the ruling intends.
   */
  it("accepts target_kind='post' with BOTH post_id and comment_id null (the orphaned-after-deletion shape)", async () => {
    const id = await insertNotice({ targetKind: "post", postId: null, commentId: null });
    const { rows } = await client.query<{ post_id: string | null; comment_id: string | null }>(
      "SELECT post_id, comment_id FROM dsa_notices WHERE id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ post_id: null, comment_id: null });
  });

  it("rejects a reason outside REPORT_REASONS (dsa_notices_reason_check)", async () => {
    const author = await makeUser();
    createdUserIds.push(author);
    const postId = await makePost(author);

    await expect(
      insertNotice({ postId, reason: "nonsense" }),
    ).rejects.toMatchObject({ code: "23514", constraint: "dsa_notices_reason_check" });
  });

  it("rejects a blank statement (dsa_notices_statement_check)", async () => {
    const author = await makeUser();
    createdUserIds.push(author);
    const postId = await makePost(author);

    await expect(
      insertNotice({ postId, statement: "   " }),
    ).rejects.toMatchObject({ code: "23514", constraint: "dsa_notices_statement_check" });
  });

  it("rejects a blank reporter_name (dsa_notices_reporter_name_check)", async () => {
    const author = await makeUser();
    createdUserIds.push(author);
    const postId = await makePost(author);

    await expect(
      insertNotice({ postId, reporterName: "   " }),
    ).rejects.toMatchObject({ code: "23514", constraint: "dsa_notices_reporter_name_check" });
  });

  it("rejects good_faith = false (dsa_notices_good_faith_check)", async () => {
    const author = await makeUser();
    createdUserIds.push(author);
    const postId = await makePost(author);

    await expect(
      insertNotice({ postId, goodFaith: false }),
    ).rejects.toMatchObject({ code: "23514", constraint: "dsa_notices_good_faith_check" });
  });

  /**
   * Addendum (PM ruling, 2026-10-01): schema option B. `ON DELETE SET NULL`
   * replaces the original CASCADE — DSA Art. 16(5)/17 require an outcome to
   * the reporter whatever happens to the content, so an author must not be
   * able to make a CONFIRMED notice disappear by deleting the post it names.
   *
   * Mutation proof (final-fix-report): with the FK reverted to CASCADE, this
   * exact assertion ("the notice survives with NULL post_id") FAILS — the
   * row is gone instead, same as the OLD behaviour this replaces — and PASSES
   * again once the FK is SET NULL. See the final-fix-report for the recorded
   * FAIL→PASS run.
   */
  it("the notice SURVIVES with a NULL post_id when its target post is deleted (ON DELETE SET NULL); a notice on a different post is unaffected", async () => {
    const author = await makeUser();
    createdUserIds.push(author);
    const deletedPost = await makePost(author);
    const survivingPost = await makePost(author);

    const orphanedNoticeId = await insertNotice({ targetKind: "post", postId: deletedPost });
    const survivingNoticeId = await insertNotice({ targetKind: "post", postId: survivingPost });

    await client.query("DELETE FROM posts WHERE id = $1", [deletedPost]);

    const { rows: orphanedRows } = await client.query<{ post_id: string | null }>(
      "SELECT post_id FROM dsa_notices WHERE id = $1",
      [orphanedNoticeId],
    );
    expect(orphanedRows).toHaveLength(1);
    expect(orphanedRows[0]!.post_id).toBeNull();

    const { rows: survivingRows } = await client.query<{ post_id: string | null }>(
      "SELECT post_id FROM dsa_notices WHERE id = $1",
      [survivingNoticeId],
    );
    expect(survivingRows).toHaveLength(1);
    expect(survivingRows[0]!.post_id).toBe(survivingPost);
  });
});
