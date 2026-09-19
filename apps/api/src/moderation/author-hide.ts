/**
 * THE ONE WAY an author hides or unhides their OWN post — the other case in
 * CireSnave's ruling on #26 (community#66's design note), stacked on that
 * PR's media-visibility hook.
 *
 * ⚠️ SAME SHAPE AS decide.ts, DELIBERATELY: `hidden_at` is the only column
 * that governs visibility (AC-5); "why" is read from `moderation_actions`.
 * `hide`/`unhide` share this module because they are the two directions of
 * the SAME author-ownership predicate, and `unhide` additionally needs to
 * read the log `hide` writes to.
 *
 * Takes the caller's existing `pg.Client`, matching decide.ts / actions.ts.
 */
import type { Client } from "pg";

import { BEGIN_BOUNDED_TX } from "../db/client";
import { recordModerationAction } from "./actions";
import { loadPostTagSlugs } from "./purge-target";

export interface AuthorHideResult {
  readonly hidden: boolean;
  /** True only when THIS call actually flipped `hidden_at` — gates the media move + purge. */
  readonly changed: boolean;
  readonly authorId: string;
  readonly tagSlugs: readonly string[];
}

/**
 * `hide`: idempotent. A post already hidden (by anything — auto-hide,
 * a moderator, or a prior author-hide) is left exactly as it was; `hidden_at`
 * is NEVER restamped (same COALESCE reasoning as decide.ts's R2 — the
 * ORIGINAL hide time is evidence).
 */
export async function hidePost(c: Client, postId: string, authorId: string): Promise<AuthorHideResult | null> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const { rows } = await c.query<{ id: string; author_id: string; email: string; was_hidden: boolean }>(
      `UPDATE posts AS t
          SET hidden_at = COALESCE(hidden_at, now())
        -- ⚠️ OWNERSHIP IS THIS LINE, not a preceding SELECT — same race-safety
        -- reasoning as posts.ts's handleUpdatePost/handleDeletePost.
        FROM users u
        WHERE t.id = $1 AND t.author_id = $2 AND u.id = t.author_id
        RETURNING t.id, t.author_id, u.email, (old.hidden_at IS NOT NULL) AS was_hidden`,
      [postId, authorId],
    );
    const row = rows[0];
    if (row === undefined) {
      await c.query("ROLLBACK").catch(() => {});
      return null;
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
    return { hidden: true, changed, authorId: row.author_id, tagSlugs };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

export type UnhideOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "already_visible" }
  | { readonly kind: "not_reversible" } // hidden for a reason the author cannot lift
  | { readonly kind: "unhidden"; readonly result: AuthorHideResult };

/**
 * `unhide`: only when the CURRENT hide is the author's own. Gated on the
 * latest `moderation_actions` row for this post being `author_hide` — a
 * moderator's `content_keep_hidden`/`content_remove`, or no row at all
 * (auto-hide still pending review), both refuse. That gate is IN the UPDATE's
 * WHERE clause (a scalar-subquery comparison), not a preceding branch, for
 * the same race-safety reason as the ownership check.
 */
export async function unhidePost(c: Client, postId: string, authorId: string): Promise<UnhideOutcome> {
  await c.query(BEGIN_BOUNDED_TX);
  try {
    const { rows } = await c.query<{ id: string; author_id: string; email: string }>(
      `UPDATE posts AS t
          SET hidden_at = NULL
        FROM users u
        WHERE t.id = $1 AND t.author_id = $2 AND u.id = t.author_id AND t.hidden_at IS NOT NULL
          AND (SELECT ma.action FROM moderation_actions ma
                WHERE ma.post_id = t.id ORDER BY ma.created_at DESC LIMIT 1) = 'author_hide'
        RETURNING t.id, t.author_id, u.email`,
      [postId, authorId],
    );
    const row = rows[0];
    if (row === undefined) {
      // Zero rows is ambiguous by construction (ownership, already-visible,
      // and not-reversible all fall through here) — a read-only probe, SCOPED
      // TO THE SAME author_id predicate so a non-owner learns nothing,
      // disambiguates. Same pattern as comments.ts's delete idempotency probe.
      const { rows: probeRows } = await c.query<{ hidden_at: Date | null }>(
        `SELECT hidden_at FROM posts WHERE id = $1 AND author_id = $2`,
        [postId, authorId],
      );
      await c.query("ROLLBACK").catch(() => {});
      const probe = probeRows[0];
      if (probe === undefined) return { kind: "not_found" };
      if (probe.hidden_at === null) return { kind: "already_visible" };
      return { kind: "not_reversible" };
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
    return { kind: "unhidden", result: { hidden: false, changed: true, authorId: row.author_id, tagSlugs } };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
