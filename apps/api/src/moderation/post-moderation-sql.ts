// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The SQL fragments that say who controls a post's visibility. A LEAF module on purpose: it imports nothing that needs
 * the Worker's ambient types (author-hide.ts pulls in db/client.ts), so node-project code such as references/attach.ts
 * can share the ONE definition without dragging Worker types into its typecheck. author-hide.ts re-exports it.
 */
import { VISIBILITY_ACTION_KINDS_SQL } from "./visibility-actions";

/**
 * True only when the post's current hide (if any) is the author's own.
 *
 * ⚠️ FIXED (was a shipped bug): the subquery MUST filter to
 * visibility-affecting actions before taking the latest one.
 * `moderation_actions` is deliberately ONE shared log carrying non-visibility
 * actions too — `media_access` (0016) is the confirmed live case: an ADMIN
 * viewing a hidden post's restricted media (`routes/media-restricted.ts`'s
 * ordinary tier) appends a `media_access` row WITH that post's `post_id`.
 * An unfiltered "latest row of ANY kind" then reads that `media_access` row
 * as the current answer to "why is this hidden", the `= 'author_hide'`
 * comparison goes false, and the author is silently and permanently locked
 * out of unhiding their own post — even though no moderator ever acted.
 * `moderation/queue.ts`'s own `content\_%` filter is the existing, correct
 * precedent in this same module area for the same log. See
 * test/author-hide-media-access-interleaving.test.ts, which reproduces the
 * exact interleaving (author_hide -> media_access -> unhide) and pins that
 * unhide still succeeds.
 *
 * The action list lives in visibility-actions.ts, shared with
 * hidden-reason.ts's READ of the same fact (#78) — one list, so the gate and
 * the read can never disagree about what counts as visibility-affecting.
 */
export const LATEST_VISIBILITY_ACTION_IS_AUTHOR_HIDE_SQL = `
  (SELECT ma.action FROM moderation_actions ma
    WHERE ma.post_id = t.id
      AND ma.action IN (${VISIBILITY_ACTION_KINDS_SQL})
    ORDER BY ma.created_at DESC LIMIT 1) = 'author_hide'`;

/**
 * "No moderator or pending auto-hide controls this post's visibility" — the
 * post is visible, or hidden only by its author. Expects the post aliased `t`.
 *
 * THE ONE definition of "under moderation" for a post: `hidePost` below gates
 * on it, and `handleUpdatePost` (routes/posts.ts) freezes edits on its
 * negation (#58), so the author may edit exactly the posts they could also
 * hide/unhide themselves. Do not re-derive it at a call site.
 */
export const POST_NOT_UNDER_MODERATION_SQL = `(t.hidden_at IS NULL OR ${LATEST_VISIBILITY_ACTION_IS_AUTHOR_HIDE_SQL})`;
