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
    postId: null as string | null,
    commentId: null as string | null,
    reason: "spam",
    statement: "This infringes my copyright.",
    ...overrides,
  };
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO dsa_notices
       (reporter_email, reporter_name, good_faith, verify_token_hash,
        post_id, comment_id, reason, statement)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      opts.reporterEmail,
      opts.reporterName,
      opts.goodFaith,
      opts.verifyTokenHash,
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

  it("rejects a row with neither post_id nor comment_id set (dsa_notices_one_target)", async () => {
    await expect(
      insertNotice({ postId: null, commentId: null }),
    ).rejects.toMatchObject({ code: "23514", constraint: "dsa_notices_one_target" });
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

  it("cascade-deletes notices when the target post is deleted; a notice on a different post survives", async () => {
    const author = await makeUser();
    createdUserIds.push(author);
    const deletedPost = await makePost(author);
    const survivingPost = await makePost(author);

    const deletedNoticeId = await insertNotice({ postId: deletedPost });
    const survivingNoticeId = await insertNotice({ postId: survivingPost });

    await client.query("DELETE FROM posts WHERE id = $1", [deletedPost]);

    const { rows: deletedRows } = await client.query(
      "SELECT 1 FROM dsa_notices WHERE id = $1",
      [deletedNoticeId],
    );
    expect(deletedRows).toHaveLength(0);

    const { rows: survivingRows } = await client.query(
      "SELECT 1 FROM dsa_notices WHERE id = $1",
      [survivingNoticeId],
    );
    expect(survivingRows).toHaveLength(1);
  });
});
