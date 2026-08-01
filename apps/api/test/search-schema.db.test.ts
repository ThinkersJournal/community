import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/thinkersjournal_test";

let client: Client;
let author: string;
beforeAll(async () => {
  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`search-${crypto.randomUUID()}@t.test`],
  );
  author = rows[0]!.id;
  await client.query(
    `INSERT INTO profiles (user_id, username, display_name, bio, username_chosen)
     VALUES ($1, $2, 'Ada Lovelace', 'writes about analytical engines', true)`,
    [author, `ada_${author.slice(0, 8)}`],
  );
});
afterAll(async () => {
  await client.query(`DELETE FROM users WHERE id = $1`, [author]);
  await client.end();
});

async function searchPosts(q: string): Promise<string[]> {
  await client.query("BEGIN; SET LOCAL pg_trgm.word_similarity_threshold = 0.3");
  try {
    const { rows } = await client.query<{ id: string }>(
      `SELECT p.id
         FROM posts p
        WHERE p.status = 'published'
          AND lower($1) <% lower(p.title || ' ' || coalesce(p.markdown_source, ''))
        ORDER BY word_similarity(lower($1), lower(p.title || ' ' || coalesce(p.markdown_source, ''))) DESC, p.id DESC`,
      [q],
    );
    return rows.map((r) => r.id);
  } finally {
    await client.query("COMMIT");
  }
}

describe("0009 search trigram", () => {
  it("pg_trgm extension is installed", async () => {
    const { rows } = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(rows).toHaveLength(1);
  });

  it("both trigram GIN indexes exist", async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('posts_search_trgm_idx','profiles_search_trgm_idx')`,
    );
    expect(rows.map((r) => r.indexname).sort()).toEqual(["posts_search_trgm_idx", "profiles_search_trgm_idx"]);
  });

  it("finds a published post by a partial + typo query, excludes drafts", async () => {
    const { rows: pub } = await client.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 'Notes on the Analytical Engine', $2, 'body about engines', 'published', now()) RETURNING id`,
      [author, `s-${crypto.randomUUID()}`],
    );
    const { rows: draft } = await client.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status)
       VALUES ($1, 'Analytical Engine Draft', $2, 'secret draft', 'draft') RETURNING id`,
      [author, `s-${crypto.randomUUID()}`],
    );
    const hits = await searchPosts("analitcal engin"); // typo'd + partial
    expect(hits).toContain(pub[0]!.id);
    expect(hits).not.toContain(draft[0]!.id);
  });

  it("uses the GIN index for the filter (not a seq scan)", async () => {
    const { rows } = await client.query<{ "QUERY PLAN": unknown[] }>(
      `EXPLAIN (FORMAT JSON) SELECT p.id FROM posts p
        WHERE p.status = 'published'
          AND lower('analytical engine') <% lower(p.title || ' ' || coalesce(p.markdown_source, ''))`,
    );
    expect(JSON.stringify(rows[0])).toContain("posts_search_trgm_idx");
  });

  it("finds an onboarded person by partial name, excludes un-onboarded", async () => {
    const { rows: u } = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`hidden-${crypto.randomUUID()}@t.test`],
    );
    const hiddenId = u[0]!.id;
    await client.query(
      `INSERT INTO profiles (user_id, username, display_name, username_chosen) VALUES ($1, $2, 'Ada Hidden', false)`,
      [hiddenId, `ada_hidden_${hiddenId.slice(0, 8)}`],
    );
    try {
      await client.query("BEGIN; SET LOCAL pg_trgm.word_similarity_threshold = 0.3");
      const { rows } = await client.query<{ username: string }>(
        `SELECT pr.username FROM profiles pr
          WHERE pr.username_chosen = true
            AND lower($1) <% lower(coalesce(pr.username::text,'') || ' ' || coalesce(pr.display_name,'') || ' ' || coalesce(pr.bio,''))`,
        ["ada lovelace"],
      );
      await client.query("COMMIT");
      const names = rows.map((r) => r.username);
      expect(names.some((n) => n.startsWith("ada_") && !n.includes("hidden"))).toBe(true);
      expect(names.some((n) => n.includes("hidden"))).toBe(false);
    } finally {
      await client.query(`DELETE FROM users WHERE id = $1`, [hiddenId]);
    }
  });
});
