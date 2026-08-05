/**
 * Pure SQL strings for /public/search (M2.4a).
 *
 * ⚠️ ZERO IMPORTS BY DESIGN. This module is imported both by the Worker handler
 * (`search.ts`) and by a plain Node DB test (`test/search-schema.db.test.ts`)
 * that runs OUTSIDE workerd — so it must not pull in anything from the Worker
 * runtime. Keep it a pair of exported string constants and nothing else.
 *
 * ⚠️ The `<%` filter / `word_similarity(...)` expressions here MUST stay a
 * byte-for-byte parse-tree match for the partial GIN indexes in migration 0009,
 * or Postgres silently falls back to a seq scan over every published post. That
 * coupling is pinned by a deterministic source-text comparison in
 * search-schema.db.test.ts (handler expression vs migration 0009's index
 * expression, alias/whitespace-normalized) — it fails if the two ever diverge.
 */

export const POSTS_SQL = `
  SELECT p.id, p.title, p.slug,
         left(p.markdown_source, 400) AS "excerptSource",
         p.published_at AS "publishedAt",
         pr.username AS "authorUsername",
         pr.display_name AS "authorDisplayName"
    FROM posts p
    JOIN profiles pr ON pr.user_id = p.author_id
   WHERE p.status = 'published'
     AND lower($1) <% lower(p.title || ' ' || coalesce(p.markdown_source, ''))
   ORDER BY word_similarity(lower($1), lower(p.title || ' ' || coalesce(p.markdown_source, ''))) DESC,
            p.id DESC
   LIMIT $2 OFFSET $3`;

export const PEOPLE_SQL = `
  SELECT pr.username, pr.display_name AS "displayName", pr.bio
    FROM profiles pr
   WHERE pr.username_chosen = true
     AND lower($1) <% lower(coalesce(pr.username::text,'') || ' ' || coalesce(pr.display_name,'') || ' ' || coalesce(pr.bio,''))
   ORDER BY word_similarity(lower($1), lower(coalesce(pr.username::text,'') || ' ' || coalesce(pr.display_name,'') || ' ' || coalesce(pr.bio,''))) DESC,
            pr.user_id DESC
   LIMIT $2 OFFSET $3`;
