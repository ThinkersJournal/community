// SPDX-License-Identifier: MIT OR Apache-2.0
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

/**
 * The `content_*` kinds that are a HUMAN RULING on a post/comment: the ONE list
 * every "has a moderator handled / decided this?" reader filters to. Replaces
 * the former `action LIKE 'content\_%'` pattern, which would have swept in
 * `content_auto_hide` (#57, Q4=B).
 *
 * ⚠️ `content_auto_hide` is deliberately NOT here, nor in VISIBILITY_ACTION_KINDS.
 * It records that automation hid the content, and decides nothing: it must not
 * close the item in the moderation queue, reset auto-hide's own report cut-off,
 * supersede an appealed decision, or become what /appeals/for-post offers.
 * Auto-hide only fires on content with `hidden_at IS NULL`, so any earlier
 * human ruling that hid it was reversed by a `content_restore` first.
 */
export const HUMAN_CONTENT_RULING_KINDS: readonly ModerationActionKind[] = [
  "content_restore",
  "content_keep_hidden",
  "content_remove",
];

/** The same list, as a SQL `IN (...)` literal — for embedding in a query string. */
export const HUMAN_CONTENT_RULING_KINDS_SQL = HUMAN_CONTENT_RULING_KINDS.map((k) => `'${k}'`).join(",");

/** The same list, as a SQL `IN (...)` literal — for embedding in a query string. */
export const VISIBILITY_ACTION_KINDS_SQL = VISIBILITY_ACTION_KINDS.map((k) => `'${k}'`).join(",");
