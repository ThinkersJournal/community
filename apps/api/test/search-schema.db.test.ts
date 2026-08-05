import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PEOPLE_SQL, POSTS_SQL } from "../src/routes/search-sql";

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

  it("ranks a closer match ahead of a weaker one for the same query", async () => {
    // Scores checked directly against word_similarity() beforehand: close ~1.0,
    // far ~0.61 — both clear the 0.3 SET LOCAL threshold used by searchPosts(), so
    // both rows are returned, and the ordering between them is unambiguous.
    const { rows: close } = await client.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 'Distributed Systems Architecture Patterns', $2,
               'a deep look at distributed systems architecture patterns for scale',
               'published', now()) RETURNING id`,
      [author, `s-${crypto.randomUUID()}`],
    );
    const { rows: far } = await client.query<{ id: string }>(
      `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
       VALUES ($1, 'Random Thoughts on Software', $2,
               'some notes touching on distributed systems in passing among other software topics',
               'published', now()) RETURNING id`,
      [author, `s-${crypto.randomUUID()}`],
    );
    try {
      const hits = await searchPosts("distributed systems architecture");
      expect(hits).toContain(close[0]!.id);
      expect(hits).toContain(far[0]!.id);
      expect(hits.indexOf(close[0]!.id)).toBeLessThan(hits.indexOf(far[0]!.id));
    } finally {
      await client.query(`DELETE FROM posts WHERE id = ANY($1)`, [[close[0]!.id, far[0]!.id]]);
    }
  });

  it("both trigram indexes are GIN trgm over the right expressions + partial predicates", async () => {
    // NOTE: we deliberately do NOT assert the planner CHOOSES this index. At any
    // realistic test volume Postgres correctly prefers the cheaper posts_published_key
    // btree-partial (migration 0002) + an in-memory <% filter; the GIN trigram index is
    // a large-corpus optimization the planner adopts only past its cost crossover. We
    // pin the index DEFINITION instead — that (plus the behavioral tests above) is what
    // guards the expression/opclass/partial-predicate, deterministically.
    const def = async (name: string): Promise<string> => {
      const { rows } = await client.query<{ d: string }>(
        `SELECT pg_get_indexdef(c.oid) AS d FROM pg_class c WHERE c.relname = $1 AND c.relkind = 'i'`, [name]);
      return rows[0]?.d ?? "";
    };
    const posts = await def("posts_search_trgm_idx");
    expect(posts).toContain("gin_trgm_ops");
    expect(posts).toContain("lower(");
    expect(posts).toContain("title");
    // COALESCE, not a bare column ref — otherwise a NULL markdown_source makes the
    // whole concatenation NULL and that post silently drops out of the index.
    expect(posts).toContain("COALESCE(markdown_source");
    expect(posts.toLowerCase()).toContain("where (status = 'published'");
    const people = await def("profiles_search_trgm_idx");
    expect(people).toContain("gin_trgm_ops");
    expect(people).toContain("lower(");
    // citext -> text cast, required for the concatenation to typecheck.
    expect(people).toContain("(username)::text");
    // Same NULL-propagation guard as above, for the two nullable profile columns.
    expect(people).toContain("COALESCE(display_name");
    expect(people).toContain("COALESCE(bio");
    expect(people.toLowerCase()).toContain("where (username_chosen");
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

  it("couples the handler SQL to the trgm GIN indexes (planner-forced EXPLAIN)", async () => {
    // The index-def pin above guards the INDEX side. This guards the HANDLER side:
    // it EXPLAINs the REAL POSTS_SQL / PEOPLE_SQL (imported from src/routes/search-sql,
    // the same strings the Worker runs) and proves the trigram GIN is actually usable
    // for them. The mechanism: force the planner off every non-GIN access path so the
    // GIN bitmap scan is the ONLY cheap plan — which the planner can choose ONLY IF the
    // handler expression parses byte-for-byte identically to the index expression. If a
    // future refactor makes them diverge (e.g. `||` -> `concat_ws`), the GIN stops being
    // usable, the plan falls back, and this test goes red instead of silently shipping a
    // seq scan over every published post.
    //
    // Everything runs in ONE rolled-back transaction: SET LOCAL + seeded rows + ANALYZE
    // are all reverted, and there is NO DDL (no DROP/CREATE INDEX), so it never takes an
    // ACCESS EXCLUSIVE lock on the shared test DB (only ROW EXCLUSIVE inserts + ANALYZE's
    // SHARE UPDATE EXCLUSIVE, both compatible with the concurrent pool project's DML).
    const sfx = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await client.query("BEGIN");
    try {
      // Posts: one author + 40 matching + 400 non-matching published posts, so the
      // `<%` predicate is selective enough that the GIN bitmap is the cheap plan.
      const { rows: au } = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
        [`explain-author-${sfx}@t.test`],
      );
      const authorId = au[0]!.id;
      await client.query(
        `INSERT INTO profiles (user_id, username, display_name, bio, username_chosen)
         VALUES ($1, $2, 'Explain Author', 'author bio', true)`,
        [authorId, `expauth_${sfx}`],
      );
      await client.query(
        `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
         SELECT $1, 'Distributed Systems Architecture Patterns ' || g, 'ex-' || $2 || '-m-' || g,
                'a deep look at distributed systems architecture patterns for scale ' || g,
                'published', now()
         FROM generate_series(1, 40) g`,
        [authorId, sfx],
      );
      await client.query(
        `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
         SELECT $1, 'Cooking with vegetables number ' || g, 'ex-' || $2 || '-o-' || g,
                'recipes about soups and breads and pastry techniques ' || g,
                'published', now()
         FROM generate_series(1, 400) g`,
        [authorId, sfx],
      );

      // People: 30 matching + 400 non-matching onboarded profiles (each needs a user).
      await client.query(
        `WITH nu AS (
           INSERT INTO users (email, password_hash)
           SELECT 'ex-pm-' || $1 || '-' || g || '@t.test', 'x' FROM generate_series(1, 30) g
           RETURNING id
         )
         INSERT INTO profiles (user_id, username, display_name, bio, username_chosen)
         SELECT id, 'expm_' || $1 || '_' || row_number() over (), 'Grace Hopper Fan',
                'writes about compilers', true
         FROM nu`,
        [sfx],
      );
      await client.query(
        `WITH nu AS (
           INSERT INTO users (email, password_hash)
           SELECT 'ex-po-' || $1 || '-' || g || '@t.test', 'x' FROM generate_series(1, 400) g
           RETURNING id
         )
         INSERT INTO profiles (user_id, username, display_name, bio, username_chosen)
         SELECT id, 'expo_' || $1 || '_' || row_number() over (), 'Zebra Quilting Enthusiast',
                'talks about textiles and yarn', true
         FROM nu`,
        [sfx],
      );

      await client.query("ANALYZE posts");
      await client.query("ANALYZE profiles");

      // Disable seq scan + plain/index-only index scans so the ONLY remaining cheap path
      // for the `<%` predicate is a bitmap scan over the trigram GIN.
      await client.query(
        `SET LOCAL pg_trgm.word_similarity_threshold = 0.3;
         SET LOCAL enable_seqscan = off;
         SET LOCAL enable_indexscan = off;
         SET LOCAL enable_indexonlyscan = off`,
      );

      const planFor = async (sql: string, q: string): Promise<string> => {
        const { rows } = await client.query<Record<string, string>>(`EXPLAIN ${sql}`, [q, 21, 0]);
        return rows.map((r) => r["QUERY PLAN"]).join("\n");
      };

      const postsPlan = await planFor(POSTS_SQL, "distributed systems architecture");
      const peoplePlan = await planFor(PEOPLE_SQL, "grace hopper");

      // The load-bearing assertion is the `%>` INDEX CONDITION, not the bare index name.
      // A diverged expression can still touch the partial GIN for its predicate
      // (`Recheck Cond: username_chosen`) with the `<%` demoted to a Filter — so the name
      // alone would false-pass. `%>` (the trigram commutator) appears in the plan ONLY
      // when the GIN actually serves the search expression, i.e. only when the handler
      // expression matches the index expression. Manually verified during authoring:
      // perturbing either expression (`||` -> `concat_ws`) drops `%>` from the plan and
      // makes this test fail.
      expect(postsPlan).toContain("posts_search_trgm_idx");
      expect(postsPlan).toContain("%>");
      expect(peoplePlan).toContain("profiles_search_trgm_idx");
      expect(peoplePlan).toContain("%>");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
