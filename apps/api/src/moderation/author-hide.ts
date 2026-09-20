/**
 * THE ONE WAY an author hides or unhides their OWN post — the other case in
 * CireSnave's ruling on #26 (community#66's design note), stacked on that
 * PR's media-visibility hook.
 *
 * ⚠️ SAME SHAPE AS decide.ts, DELIBERATELY: `hidden_at` is the only column
 * that governs visibility (AC-5); "why" is read from `moderation_actions`.
 * `hide`/`unhide` share this module because both gate on the SAME fact: is
 * the post's CURRENT hide, if any, the author's own `author_hide` — never a
 * moderator decision or an auto-hide still pending review. Neither direction
 * may proceed when that fact is false: `unhide` obviously cannot lift a hide
 * that isn't the author's; `hide` must equally REFUSE (not silently no-op)
 * when a moderator already controls the post's visibility, because a no-op
 * that returns 200 but records nothing would vanish the moment a moderator
 * later restores the post — the author's own "I want this hidden" request
 * leaves no trace to have prevented that.
 */
import type { Client } from "pg";

import { BEGIN_BOUNDED_TX } from "../db/client";
import { recordModerationAction } from "./actions";
import { loadPostTagSlugs } from "./purge-target";
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
const LATEST_VISIBILITY_ACTION_IS_AUTHOR_HIDE_SQL = `
  (SELECT ma.action FROM moderation_actions ma
    WHERE ma.post_id = t.id
      AND ma.action IN (${VISIBILITY_ACTION_KINDS_SQL})
    ORDER BY ma.created_at DESC LIMIT 1) = 'author_hide'`;

export interface AuthorHideResult {
  readonly hidden: boolean;
  readonly authorId: string;
  readonly tagSlugs: readonly string[];
}

export type HideOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "under_moderation" } // already hidden for a reason that ISN'T the author's own
  | { readonly kind: "hidden"; readonly changed: boolean; readonly result: AuthorHideResult };

/**
 * `hide`: idempotent ONLY across REPEATED author-hides — `hidden_at` is
 * NEVER restamped on a second call (same COALESCE reasoning as decide.ts's
 * R2 — the ORIGINAL hide time is evidence). A post already hidden for any
 * OTHER reason refuses (`under_moderation`) rather than absorbing the call.
 */
export async function hidePost(c: Client, postId: string, authorId: string): Promise<HideOutcome> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const { rows } = await c.query<{ id: string; author_id: string; email: string; was_hidden: boolean }>(
      `UPDATE posts AS t
          SET hidden_at = COALESCE(hidden_at, now())
        -- ⚠️ OWNERSHIP IS THIS LINE, not a preceding SELECT — same race-safety
        -- reasoning as posts.ts's handleUpdatePost/handleDeletePost. The
        -- second AND clause is the moderation gate: proceed when the post is
        -- currently visible OR already hidden by THIS SAME mechanism.
        FROM users u
        WHERE t.id = $1 AND t.author_id = $2 AND u.id = t.author_id
          AND (t.hidden_at IS NULL OR ${LATEST_VISIBILITY_ACTION_IS_AUTHOR_HIDE_SQL})
        RETURNING t.id, t.author_id, u.email, (old.hidden_at IS NOT NULL) AS was_hidden`,
      [postId, authorId],
    );
    const row = rows[0];
    if (row === undefined) {
      // Zero rows is ambiguous by construction (ownership vs. under someone
      // else's moderation both fall through here) — a read-only probe,
      // SCOPED TO THE SAME author_id predicate so a non-owner learns
      // nothing, disambiguates. Same pattern as unhide's probe below and
      // comments.ts's delete idempotency probe.
      const { rows: probeRows } = await c.query<{ id: string }>(
        `SELECT id FROM posts WHERE id = $1 AND author_id = $2`,
        [postId, authorId],
      );
      await c.query("ROLLBACK").catch(() => {});
      return probeRows[0] === undefined ? { kind: "not_found" } : { kind: "under_moderation" };
    }

    const changed = !row.was_hidden;
    if (changed) {
      await recordModerationAction(c, {
        actorAdmin: row.email, // the author's OWN identity — see this module's header
        action: "author_hide",
        reason: "The author hid this post.",
        postId: row.id,
        subjectUserId: row.author_id,
      });
    }
    const tagSlugs = await loadPostTagSlugs(c, row.id);
    await c.query("COMMIT");
    return { kind: "hidden", changed, result: { hidden: true, authorId: row.author_id, tagSlugs } };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

export type UnhideOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "already_visible" }
  | { readonly kind: "under_moderation" } // hidden for a reason the author cannot lift
  | { readonly kind: "unhidden"; readonly result: AuthorHideResult };

/**
 * `unhide`: only when the CURRENT hide is the author's own. That gate is IN
 * the UPDATE's WHERE clause (the same scalar-subquery comparison `hide`
 * uses), not a preceding branch, for the same race-safety reason as the
 * ownership check.
 *
 * ⚠️ NEVER LIFTS A LEGAL HOLD ON THE MEDIA. This function only ever runs for
 * a post whose CURRENT hide is `author_hide` — a legal hold is imposed only
 * through `decide.ts`'s moderator path, which always logs `content_remove`/
 * `content_keep_hidden`, never `author_hide`. So a post reaching here cannot
 * be under a legal hold at the POST level. Individual media KEYS can still
 * carry an independent `media_legal_holds` row (content-addressing means a
 * key can be shared with a different, legally-held post) — that is handled
 * unconditionally by `applyMediaVisibilityChange` itself, which never moves
 * a held key back to public regardless of which caller asked. Not this
 * module's job to re-check.
 */
export async function unhidePost(c: Client, postId: string, authorId: string): Promise<UnhideOutcome> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const { rows } = await c.query<{ id: string; author_id: string; email: string }>(
      `UPDATE posts AS t
          SET hidden_at = NULL
        FROM users u
        WHERE t.id = $1 AND t.author_id = $2 AND u.id = t.author_id AND t.hidden_at IS NOT NULL
          AND ${LATEST_VISIBILITY_ACTION_IS_AUTHOR_HIDE_SQL}
        RETURNING t.id, t.author_id, u.email`,
      [postId, authorId],
    );
    const row = rows[0];
    if (row === undefined) {
      // Zero rows is ambiguous by construction (ownership, already-visible,
      // and under-moderation all fall through here) — a read-only probe,
      // SCOPED TO THE SAME author_id predicate so a non-owner learns
      // nothing, disambiguates. Same pattern as comments.ts's delete
      // idempotency probe.
      const { rows: probeRows } = await c.query<{ hidden_at: Date | null }>(
        `SELECT hidden_at FROM posts WHERE id = $1 AND author_id = $2`,
        [postId, authorId],
      );
      await c.query("ROLLBACK").catch(() => {});
      const probe = probeRows[0];
      if (probe === undefined) return { kind: "not_found" };
      if (probe.hidden_at === null) return { kind: "already_visible" };
      return { kind: "under_moderation" };
    }

    await recordModerationAction(c, {
      actorAdmin: row.email, // the author's OWN identity — see this module's header
      action: "author_unhide",
      reason: "The author unhid this post.",
      postId: row.id,
      subjectUserId: row.author_id,
    });
    const tagSlugs = await loadPostTagSlugs(c, row.id);
    await c.query("COMMIT");
    return { kind: "unhidden", result: { hidden: false, authorId: row.author_id, tagSlugs } };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
