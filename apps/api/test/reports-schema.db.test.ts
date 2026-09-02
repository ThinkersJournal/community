import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
let reporter: string;
let author: string;
let postId: string;
let commentId: string;

async function makeUser(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`reports-${crypto.randomUUID()}@example.com`],
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

async function makeComment(postIdArg: string, authorId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `WITH ids AS (SELECT uuidv7() AS id)
     INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown)
     SELECT ids.id, $1, $2, NULL, ids.id::text, 0, 'hello'
       FROM ids
     RETURNING id`,
    [postIdArg, authorId],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  reporter = await makeUser();
  author = await makeUser();
  postId = await makePost(author);
  commentId = await makeComment(postId, author);
});

afterAll(async () => {
  await client.query("DELETE FROM users WHERE id = ANY($1)", [[reporter, author]]);
  await client.end();
});

describe("reports schema", () => {
  it("has expected columns and types", async () => {
    const { rows } = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'reports'`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r]));

    expect(byName.get("id")?.data_type).toBe("uuid");
    expect(byName.get("reporter_id")?.data_type).toBe("uuid");
    expect(byName.get("reporter_id")?.is_nullable).toBe("NO");
    expect(byName.get("post_id")?.data_type).toBe("uuid");
    expect(byName.get("post_id")?.is_nullable).toBe("YES");
    expect(byName.get("comment_id")?.data_type).toBe("uuid");
    expect(byName.get("comment_id")?.is_nullable).toBe("YES");
    expect(byName.get("reason")?.data_type).toBe("text");
    expect(byName.get("reason")?.is_nullable).toBe("NO");
    expect(byName.get("created_at")?.data_type).toBe("timestamp with time zone");
    expect(byName.get("created_at")?.is_nullable).toBe("NO");
  });

  it("reporter_id, post_id, comment_id are FKs to users/posts/comments", async () => {
    const { rows: fks } = await client.query(
      `SELECT kcu.column_name AS fk_column,
              ccu.table_name  AS ref_table,
              ccu.column_name AS ref_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema    = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
          AND tc.table_schema    = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema    = 'public'
          AND tc.table_name      = 'reports'
        ORDER BY kcu.column_name`,
    );

    expect(fks).toEqual([
      { fk_column: "comment_id", ref_table: "comments", ref_column: "id" },
      { fk_column: "post_id", ref_table: "posts", ref_column: "id" },
      { fk_column: "reporter_id", ref_table: "users", ref_column: "id" },
    ]);
  });

  it("assigns a uuidv7 id (version nibble 7)", async () => {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO reports (reporter_id, post_id, reason) VALUES ($1,$2,'spam') RETURNING id",
      [reporter, postId],
    );
    expect(rows[0]!.id[14]).toBe("7");
    await client.query("DELETE FROM reports WHERE id = $1", [rows[0]!.id]);
  });

  it("rejects both targets set and neither target set (CHECK 23514, reports_one_target)", async () => {
    await expect(
      client.query(
        "INSERT INTO reports (reporter_id, post_id, comment_id, reason) VALUES ($1,$2,$3,'spam')",
        [reporter, postId, commentId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("INSERT INTO reports (reporter_id, reason) VALUES ($1,'spam')", [reporter]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an invalid reason (CHECK 23514, reports_reason_valid)", async () => {
    await expect(
      client.query("INSERT INTO reports (reporter_id, post_id, reason) VALUES ($1,$2,'nonsense')", [
        reporter,
        postId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts every reason in the taxonomy", async () => {
    const reasons = [
      "spam",
      "harassment",
      "hate",
      "sexual",
      "violence",
      "ip_infringement",
      "other",
    ];
    for (const reason of reasons) {
      const targetReporter = await makeUser();
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO reports (reporter_id, post_id, reason) VALUES ($1,$2,$3) RETURNING id",
        [targetReporter, postId, reason],
      );
      expect(rows).toHaveLength(1);
      await client.query("DELETE FROM users WHERE id = $1", [targetReporter]);
    }
  });

  it("enforces one report per reporter per post (unique violation 23505, reports_reporter_post_unique)", async () => {
    await client.query("INSERT INTO reports (reporter_id, post_id, reason) VALUES ($1,$2,'spam')", [
      reporter,
      postId,
    ]);
    await expect(
      client.query("INSERT INTO reports (reporter_id, post_id, reason) VALUES ($1,$2,'harassment')", [
        reporter,
        postId,
      ]),
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("DELETE FROM reports WHERE reporter_id=$1 AND post_id=$2", [reporter, postId]);
  });

  it("enforces one report per reporter per comment (unique violation 23505, reports_reporter_comment_unique)", async () => {
    await client.query(
      "INSERT INTO reports (reporter_id, comment_id, reason) VALUES ($1,$2,'spam')",
      [reporter, commentId],
    );
    await expect(
      client.query("INSERT INTO reports (reporter_id, comment_id, reason) VALUES ($1,$2,'harassment')", [
        reporter,
        commentId,
      ]),
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("DELETE FROM reports WHERE reporter_id=$1 AND comment_id=$2", [reporter, commentId]);
  });

  it("cascade-deletes reports when the reporter is deleted", async () => {
    const temp = await makeUser();
    await client.query("INSERT INTO reports (reporter_id, post_id, reason) VALUES ($1,$2,'spam')", [
      temp,
      postId,
    ]);
    await client.query("DELETE FROM users WHERE id = $1", [temp]);
    const { rows } = await client.query("SELECT 1 FROM reports WHERE reporter_id = $1", [temp]);
    expect(rows).toHaveLength(0);
  });

  it("cascade-deletes reports when the target post is deleted", async () => {
    const tempAuthor = await makeUser();
    const tempPost = await makePost(tempAuthor);
    await client.query("INSERT INTO reports (reporter_id, post_id, reason) VALUES ($1,$2,'spam')", [
      reporter,
      tempPost,
    ]);
    await client.query("DELETE FROM posts WHERE id = $1", [tempPost]);
    const { rows } = await client.query("SELECT 1 FROM reports WHERE post_id = $1", [tempPost]);
    expect(rows).toHaveLength(0);
    await client.query("DELETE FROM users WHERE id = $1", [tempAuthor]);
  });

  it("cascade-deletes reports when the target comment is deleted", async () => {
    const tempComment = await makeComment(postId, author);
    await client.query("INSERT INTO reports (reporter_id, comment_id, reason) VALUES ($1,$2,'spam')", [
      reporter,
      tempComment,
    ]);
    await client.query("DELETE FROM comments WHERE id = $1", [tempComment]);
    const { rows } = await client.query("SELECT 1 FROM reports WHERE comment_id = $1", [tempComment]);
    expect(rows).toHaveLength(0);
  });
});
