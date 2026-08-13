import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    `INSERT INTO profiles (user_id, username, display_name, bio)
     VALUES ($1, $2, 'Ada Lovelace', 'writes about analytical engines')`,
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
    // handle-at-signup Task 6: the index was rebuilt WITHOUT a partial
    // predicate (dropping the retired onboarding flag it used to filter on)
    // — every account has a handle from signup, so there is no "not yet
    // chosen" profile left to exclude. Pin the absence: no WHERE clause at
    // all on this index anymore.
    expect(people.toLowerCase()).not.toContain("where");
  });

  it("couples the handler search expression to the migration 0009 index expression", () => {
    // The index-def pin above guards the INDEX side. This guards the HANDLER side —
    // and does it WITHOUT a planner. An earlier version of this test EXPLAINed the
    // real handler SQL with `SET LOCAL enable_seqscan/indexscan/indexonlyscan = off`
    // and asserted the trgm GIN got chosen. That was fragile in a way this project's
    // migration-0002 partial btree `posts_published_key` (`ON posts (id DESC) WHERE
    // status='published'`) exposed at CI's higher published-row count: those flags do
    // NOT disable a BITMAP scan of that btree, so the planner happily picked `Bitmap
    // Index Scan on posts_published_key` + an in-memory `<%` Filter instead of the
    // GIN — passing locally (lower row count, GIN cheaper) and failing in CI (more
    // rows, btree-bitmap cheaper). Forcing the GIN would require either DROPping
    // posts_published_key (an ACCESS EXCLUSIVE lock hazard on the shared test DB) or
    // disabling bitmap scans too, which kills the GIN path as well. Dead end — the
    // planner's choice of ACCESS PATH is not the invariant we actually care about.
    //
    // What we actually need to guard: the handler's `<%`/word_similarity expression
    // (POSTS_SQL / PEOPLE_SQL — the literal strings the Worker runs) must parse
    // byte-for-byte identically to migration 0009's GIN index expression, or Postgres
    // silently stops being ABLE to use the index at all (falls back to a seq scan
    // over every published post, no matter what the planner would otherwise prefer).
    // That's a source-text property, not a runtime one — so test it directly: no DB
    // planner, no seeded rows, no locks, no environment sensitivity.
    const migrationSql = readFileSync(
      join(import.meta.dirname, "..", "migrations", "0009_search_trgm.sql"),
      "utf8",
    );

    /** The `lower(...)` expression to the right of `<%` in a handler SQL string. */
    const extractHandlerExpr = (sql: string): string => {
      const marker = "<%";
      const markerIdx = sql.indexOf(marker);
      if (markerIdx === -1) throw new Error(`no "<%" found in handler SQL: ${sql}`);
      const rest = sql.slice(markerIdx + marker.length);
      const newlineIdx = rest.indexOf("\n");
      return (newlineIdx === -1 ? rest : rest.slice(0, newlineIdx)).trim();
    };

    /** The `lower(...)` expression inside `USING gin (<expr> gin_trgm_ops)` for one index. */
    const extractIndexExpr = (createIndexNeedle: string): string => {
      const lines = migrationSql.split("\n");
      const startIdx = lines.findIndex((l) => l.includes(createIndexNeedle));
      if (startIdx === -1) {
        throw new Error(`"${createIndexNeedle}" not found in migration 0009 — has it been renamed?`);
      }
      const ginLine = lines.slice(startIdx).find((l) => l.includes("gin_trgm_ops"));
      if (ginLine === undefined) {
        throw new Error(`no "gin_trgm_ops" line found after "${createIndexNeedle}" in migration 0009`);
      }
      const openMarker = "gin (";
      const openIdx = ginLine.indexOf(openMarker);
      const closeMarker = ") gin_trgm_ops)";
      const closeIdx = ginLine.indexOf(closeMarker, openIdx);
      if (openIdx === -1 || closeIdx === -1) {
        throw new Error(`could not parse an index expression out of: ${ginLine}`);
      }
      // +1 so the slice includes the ")" that closes the expression's own lower(...).
      return ginLine.slice(openIdx + openMarker.length, closeIdx + 1);
    };

    // The two sides differ ONLY by (a) table-alias prefixes (`p.` / `pr.` in the
    // handler, none in the index expression), and (b) cosmetic spacing (e.g. the
    // handler's `coalesce(x::text,'')` vs the migration's `coalesce(x::text, '')`).
    // The literal concatenation space `' '` MUST be preserved as distinct from an
    // empty-string default, so protect it before stripping whitespace.
    const norm = (s: string) =>
      s
        .replace(/'\s'/g, "§S§") // protect the literal ' ' concat-space
        .replace(/\b(?:p|pr)\./g, "") // strip table-alias prefixes
        .replace(/\s+/g, "") // drop all remaining whitespace (kills the comma-space diff)
        .toLowerCase();

    const handlerPostsExpr = extractHandlerExpr(POSTS_SQL);
    const migrationPostsExpr = extractIndexExpr("posts_search_trgm_idx");
    expect(norm(handlerPostsExpr)).toBe(norm(migrationPostsExpr));

    const handlerPeopleExpr = extractHandlerExpr(PEOPLE_SQL);
    const migrationPeopleExpr = extractIndexExpr("profiles_search_trgm_idx");
    expect(norm(handlerPeopleExpr)).toBe(norm(migrationPeopleExpr));
  });
});
