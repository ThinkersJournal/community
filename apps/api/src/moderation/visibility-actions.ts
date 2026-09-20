/**
 * The `moderation_actions` action kinds that actually change or explain a
 * post/comment's VISIBILITY — the ONE list `author-hide.ts`'s gate and
 * `hidden-reason.ts`'s read both filter to, so they can never drift apart on
 * what counts. `moderation_actions` is a shared, append-only log that also
 * carries non-visibility rows (`media_access`, and eventually `appeal_*`/
 * `user_*`) — see author-hide.ts's header for the bug this list exists to
 * prevent a recurrence of.
 */
import type { ModerationActionKind } from "./actions";

export const VISIBILITY_ACTION_KINDS: readonly ModerationActionKind[] = [
  "author_hide",
  "author_unhide",
  "content_restore",
  "content_keep_hidden",
  "content_remove",
];

/** The same list, as a SQL `IN (...)` literal — for embedding in a query string. */
export const VISIBILITY_ACTION_KINDS_SQL = VISIBILITY_ACTION_KINDS.map((k) => `'${k}'`).join(",");
