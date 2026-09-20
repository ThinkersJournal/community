/**
 * "Is this media key still reachable through a publicly visible post or
 * comment?" — the reachability rule that decides whether a hide/restore
 * transition needs to move an R2 object between the public and restricted
 * buckets (issue #61).
 *
 * Content-addressing means one r2_key can be embedded in several posts/
 * comments (0002's note on `media.r2_key`), so this is a query over ALL
 * subjects, never a fact read off the one subject that just changed.
 *
 * ⚠️ NOT for legally-held keys — a legal hold restricts the OBJECT
 * unconditionally (src/media/legal-hold.ts) and never consults this.
 */
import type { Client } from "pg";

const MEDIA_KEY_REGEX_SQL = "media/post/([0-9a-f]{64})\\.webp";

/**
 * @param excludeSubject when set, that subject's own reference doesn't count
 *   — used when checking "is this key ALSO used elsewhere" right after the
 *   subject itself just became hidden (it is about to stop being a public
 *   reference, so it must not vote for its own key staying public).
 */
export async function isKeyPubliclyReachable(
  c: Client,
  sha256: string,
  excludeSubject?: { readonly kind: "post" | "comment"; readonly id: string },
): Promise<boolean> {
  const { rows } = await c.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM posts p
        WHERE p.status = 'published' AND p.hidden_at IS NULL
          AND ($2::text IS NULL OR NOT ($3 = 'post' AND p.id::text = $2))
          AND p.markdown_source ~ ('media/post/' || $1 || '\\.webp')
       UNION ALL
       SELECT 1 FROM comments c2
        WHERE c2.hidden_at IS NULL
          AND ($2::text IS NULL OR NOT ($3 = 'comment' AND c2.id::text = $2))
          AND c2.body_markdown ~ ('media/post/' || $1 || '\\.webp')
     ) AS exists`,
    [sha256, excludeSubject?.id ?? null, excludeSubject?.kind ?? null],
  );
  return rows[0]!.exists;
}

/** Every distinct media sha256 a subject's stored text references. */
export async function mediaKeysReferencedBy(
  c: Client,
  subject: "post" | "comment",
  subjectId: string,
): Promise<string[]> {
  const column = subject === "post" ? "markdown_source" : "body_markdown";
  const table = subject === "post" ? "posts" : "comments";
  const { rows } = await c.query<{ sha256: string }>(
    `SELECT DISTINCT (regexp_matches(${column}, '${MEDIA_KEY_REGEX_SQL}', 'g'))[1] AS sha256
       FROM ${table} WHERE id = $1`,
    [subjectId],
  );
  return rows.map((r) => r.sha256);
}
