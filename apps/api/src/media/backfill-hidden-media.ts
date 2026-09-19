/**
 * The ONE-OFF backfill for #61: every post/comment that is ALREADY hidden or
 * removed today has its media sitting on the public bucket, because the
 * visibility hook did not exist when it was hidden. This walks every such
 * subject and runs the SAME transition the hook runs on a live hide, moving
 * anything unreachable (or, going forward, legally held) into the restricted
 * bucket.
 *
 * ⚠️ IDEMPOTENT, SAFE TO RE-RUN. `applyMediaVisibilityChange` -> `moves.ts`'s
 * `runMove` already treats "object already at the destination" as success —
 * running this twice repeats some redundant `media_moves` history rows, never
 * redundant R2 work or a wrong outcome. Run it once, right after this PR
 * deploys, via `POST /admin/backfill-hidden-media` (Access-gated).
 *
 * ⚠️ CANNOT RETROACTIVELY IDENTIFY A PAST DECISION AS "LEGAL" — `legal_hold`
 * did not exist before this migration, so a hidden post from before it that
 * SHOULD have been a legal hold is backfilled as an ORDINARY hide (author/
 * admin-visible, not two-person-gated). If that matters for any specific past
 * decision, it needs its own manual `imposeLegalHold` call after this runs.
 */
import { withClient } from "../db/client";
import { applyMediaVisibilityChange } from "./visibility-hook";

const BATCH_SIZE = 500;

export async function backfillHiddenMedia(env: Env, ctx: ExecutionContext): Promise<{ posts: number; comments: number }> {
  const postIds = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM posts WHERE hidden_at IS NOT NULL ORDER BY id LIMIT $1`,
      [BATCH_SIZE],
    );
    return rows.map((r) => r.id);
  });
  for (const id of postIds) {
    await applyMediaVisibilityChange(env, ctx, { subject: "post", subjectId: id, hidden: true });
  }

  const commentIds = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM comments WHERE hidden_at IS NOT NULL ORDER BY id LIMIT $1`,
      [BATCH_SIZE],
    );
    return rows.map((r) => r.id);
  });
  for (const id of commentIds) {
    await applyMediaVisibilityChange(env, ctx, { subject: "comment", subjectId: id, hidden: true });
  }

  console.log(`backfill-hidden-media: ${postIds.length} post(s), ${commentIds.length} comment(s) processed`);
  return { posts: postIds.length, comments: commentIds.length };
}
