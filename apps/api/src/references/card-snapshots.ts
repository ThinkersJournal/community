// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3.10: the ONE definition of "a post's reference cards, as evidence" (migration 0044), shared by every path that copies
 * a post into `moderation_snapshots`: the author's delete (routes/posts.ts handleDeletePost) and a moderator's remove
 * (moderation/decide.ts). Two copies of this subselect would drift, and the evidence copy is the one place drift is
 * invisible until a lawyer asks for it.
 *
 * The result is a jsonb array of {token, kind, resource_key, content_hash, position, snapshot}, or NULL when the post
 * has no cards. `postIdSql` is a SQL expression naming the post's id in the enclosing statement; it is interpolated, so
 * it must be a literal column reference written by us (never user input).
 */
export function postCardSnapshotsSql(postIdSql: string): string {
  return `(SELECT jsonb_agg(jsonb_build_object(
                            'token', pr.token, 'kind', r.kind, 'resource_key', r.resource_key,
                            'content_hash', r.content_hash, 'position', pr.position, 'snapshot', r.snapshot)
                          ORDER BY pr.position, pr.id)
                     FROM post_references pr JOIN "references" r ON r.id = pr.reference_id
                    WHERE pr.post_id = ${postIdSql})`;
}
