import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
let author: string;
let postId: string;

async function makeUser(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`engagement-${crypto.randomUUID()}@example.com`],
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

async function makeComment(
  postIdArg: string,
  authorId: string,
  parent?: { id: string; path: string; depth: number },
): Promise<{ id: string; path: string; depth: number }> {
  const depth = parent === undefined ? 0 : parent.depth + 1;
  const { rows } = await client.query<{ id: string; path: string }>(
    `WITH ids AS (SELECT uuidv7() AS id)
     INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, body_markdown)
     SELECT ids.id, $1, $2, $3,
            CASE WHEN $4::text IS NULL THEN ids.id::text ELSE $4 || '/' || ids.id::text END,
            $5, 'hello'
       FROM ids
     RETURNING id, path`,
    [postIdArg, authorId, parent?.id ?? null, parent?.path ?? null, depth],
  );
  return { id: rows[0]!.id, path: rows[0]!.path, depth };
}

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  author = await makeUser();
  postId = await makePost(author);
});

afterAll(async () => {
  await client.query("DELETE FROM users WHERE id = $1", [author]);
  await client.end();
});

describe("comments schema", () => {
  it("assigns a uuidv7 id and stores the id-chain path", async () => {
    const top = await makeComment(postId, author);
    expect(top.id[14]).toBe("7");
    expect(top.path).toBe(top.id);
    const child = await makeComment(postId, author, { ...top });
    expect(child.path).toBe(`${top.path}/${child.id}`);
    // uuidv7 text sorts by time → the child sorts after its parent, siblings in
    // creation order — the ORDER BY path property everything else rides on.
    expect(child.path > top.path).toBe(true);
  });

  it("rejects depth > 8 (CHECK 23514)", async () => {
    await expect(
      client.query(
        `INSERT INTO comments (post_id, author_id, path, depth, body_markdown)
         VALUES ($1, $2, 'x', 9, 'b')`,
        [postId, author],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a body over 10000 chars (CHECK 23514)", async () => {
    await expect(
      client.query(
        `INSERT INTO comments (post_id, author_id, path, depth, body_markdown)
         VALUES ($1, $2, 'x', 0, $3)`,
        [postId, author, "a".repeat(10_001)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("cascade-deletes the subtree when a parent ROW is deleted (row deletion, not tombstoning)", async () => {
    const top = await makeComment(postId, author);
    const child = await makeComment(postId, author, { ...top });
    await client.query("DELETE FROM comments WHERE id = $1", [top.id]);
    const { rows } = await client.query("SELECT 1 FROM comments WHERE id = $1", [child.id]);
    expect(rows).toHaveLength(0);
  });

  it("cascade-deletes comments when the post is deleted", async () => {
    const p2 = await makePost(author);
    const c = await makeComment(p2, author);
    await client.query("DELETE FROM posts WHERE id = $1", [p2]);
    const { rows } = await client.query("SELECT 1 FROM comments WHERE id = $1", [c.id]);
    expect(rows).toHaveLength(0);
  });
});

describe("reactions schema", () => {
  it("rejects both targets set and neither target set (CHECK 23514)", async () => {
    const c = await makeComment(postId, author);
    await expect(
      client.query(
        "INSERT INTO reactions (user_id, post_id, comment_id, kind) VALUES ($1,$2,$3,'agree')",
        [author, postId, c.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        "INSERT INTO reactions (user_id, kind) VALUES ($1,'agree')",
        [author],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an unknown kind (CHECK 23514)", async () => {
    await expect(
      client.query(
        "INSERT INTO reactions (user_id, post_id, kind) VALUES ($1,$2,'love')",
        [author, postId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces one row per (user, target, kind) — NULLS NOT DISTINCT (23505)", async () => {
    await client.query(
      "INSERT INTO reactions (user_id, post_id, kind) VALUES ($1,$2,'insightful')",
      [author, postId],
    );
    // Without NULLS NOT DISTINCT the NULL comment_id would make every duplicate
    // distinct and this INSERT would succeed — the whole idempotency anchor.
    await expect(
      client.query(
        "INSERT INTO reactions (user_id, post_id, kind) VALUES ($1,$2,'insightful')",
        [author, postId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    // A DIFFERENT kind on the same target is fine (multi-toggle).
    await client.query(
      "INSERT INTO reactions (user_id, post_id, kind) VALUES ($1,$2,'agree')",
      [author, postId],
    );
  });

  it("cascade-deletes reactions when the comment is deleted", async () => {
    const c = await makeComment(postId, author);
    await client.query(
      "INSERT INTO reactions (user_id, comment_id, kind) VALUES ($1,$2,'curious')",
      [author, c.id],
    );
    await client.query("DELETE FROM comments WHERE id = $1", [c.id]);
    const { rows } = await client.query("SELECT 1 FROM reactions WHERE comment_id = $1", [c.id]);
    expect(rows).toHaveLength(0);
  });
});
