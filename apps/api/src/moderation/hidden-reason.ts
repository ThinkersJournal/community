/**
 * `hiddenReason` — computed inline, in SQL, from the SAME `moderation_actions`
 * log author-hide.ts's gate reads, filtered to the SAME visibility-action
 * list (visibility-actions.ts). Never stored: no new column, no parallel
 * table (#78, per CireSnave's ruling — "hidden BY THE USER" stays
 * load-bearing, and the log is the one source of truth).
 *
 * A SQL fragment, not an async helper: every caller here already reads the
 * post row (or a page of them) in one query, and `moderation_actions_post_idx`
 * (0013) makes the correlated subquery cheap per row — a second round trip
 * per post would cost more than it buys.
 *
 * Decides, WITHOUT attempting a write, whether an Unhide control should even
 * render:
 *   - `null`         — not hidden.
 *   - `"author"`      — hidden, and the author may unhide it (POST /posts/:id/unhide will succeed).
 *   - `"moderation"`  — hidden for a reason the author cannot lift: an
 *     unresolved auto-hide (no visibility row at all yet) OR a moderator's
 *     `content_keep_hidden`/`content_remove`.
 *
 * ⚠️ A UI GATE, NOT AN AUTHORIZATION CHECK. `POST /posts/:id/unhide` still
 * re-derives this itself (author-hide.ts's own gate) and refuses with
 * `POST_UNDER_MODERATION` regardless of what this said — this only decides
 * whether to show the button, never whether the action is allowed.
 */
import { VISIBILITY_ACTION_KINDS_SQL } from "./visibility-actions";

/**
 * @param postIdColumn the post id column/alias in scope at the call site
 *   (e.g. `p.id` or `t.id`) — this is ONLY ever embedded with a fixed,
 *   hand-written identifier from this codebase, never user input.
 * @param hiddenAtColumn the post's `hidden_at` column/alias in the same scope.
 */
export function hiddenReasonCaseSql(postIdColumn: string, hiddenAtColumn: string): string {
  return `CASE WHEN ${hiddenAtColumn} IS NULL THEN NULL
    WHEN (SELECT ma.action FROM moderation_actions ma
           WHERE ma.post_id = ${postIdColumn} AND ma.action IN (${VISIBILITY_ACTION_KINDS_SQL})
           ORDER BY ma.created_at DESC LIMIT 1) = 'author_hide' THEN 'author'
    ELSE 'moderation' END`;
}
