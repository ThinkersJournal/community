/**
 * The ONE-OFF backfill for #61: every post/comment that was ALREADY hidden or
 * removed before this shipped has its media sitting on the public bucket,
 * because the visibility hook did not exist when it was hidden. This walks
 * every such subject, oldest-id-first, and runs the SAME transition the hook
 * runs on a live hide.
 *
 * ⚠️ RUNS FROM THE TWO-MINUTE CRON UNTIL DONE, NOT ONLY THE ADMIN ROUTE.
 * The PM has no Cloudflare Access identity, so gating the ENTIRE backfill
 * behind `POST /admin/backfill-hidden-media` would mean CireSnave has to run
 * it by hand with a curl+Access-token dance right after every deploy — and
 * until someone does, hidden content's media stays exposed. `runOneBatch` is
 * cheap (a no-op read) once `completed_at` is set, so leaving it on the
 * two-minute cron forever costs nothing; it is what makes exposure close
 * within minutes of deploy rather than at the 04:20 daily cron. The admin
 * route still exists for a manual re-run (e.g. after `imposeLegalHold` is
 * used retroactively on backfilled content).
 *
 * ⚠️ RESUMABLE, KEYSET-PAGINATED (`media_backfill_progress`, a singleton row).
 * A plain `WHERE hidden_at IS NOT NULL LIMIT 500` with no cursor would
 * re-select the SAME oldest 500 rows forever once there are more than 500 —
 * never making progress and never finishing. The cursor advances by id even
 * when a page's rows have NOTHING to move (a hidden post with no media in it
 * is still "processed" for the sweep's purposes).
 *
 * ⚠️ IDEMPOTENT. `applyMediaVisibilityChange` -> `moves.ts`'s `runMove`
 * already treats "object already at the destination" as success, so a
 * concurrent cron tick and admin-route call overlapping is harmless — worst
 * case, some redundant `media_moves` history rows.
 *
 * ⚠️ CANNOT RETROACTIVELY IDENTIFY A PAST DECISION AS "LEGAL" — `legal_hold`
 * did not exist before this migration, so a hidden post from before it that
 * SHOULD have been a legal hold is backfilled as an ORDINARY hide (author/
 * admin-visible, not two-person-gated). If that matters for any specific past
 * decision, it needs its own manual `imposeLegalHold` call after this runs.
 */
import { withClient } from "../db/client";
import { applyMediaVisibilityChange } from "./visibility-hook";

const PAGE_SIZE = 500;

interface Progress {
  lastPostId: string | null;
  lastCommentId: string | null;
  completedAt: Date | null;
}

async function readProgress(env: Env, ctx: ExecutionContext): Promise<Progress> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ last_post_id: string | null; last_comment_id: string | null; completed_at: Date | null }>(
      `SELECT last_post_id, last_comment_id, completed_at FROM media_backfill_progress WHERE id`,
    );
    const row = rows[0]!;
    return { lastPostId: row.last_post_id, lastCommentId: row.last_comment_id, completedAt: row.completed_at };
  });
}

/** One page of work. Returns the counts processed, for the admin route's response / logs. */
export async function runOneBatch(env: Env, ctx: ExecutionContext): Promise<{ posts: number; comments: number; completed: boolean }> {
  const progress = await readProgress(env, ctx);
  if (progress.completedAt !== null) return { posts: 0, comments: 0, completed: true };

  const postIds = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM posts
        WHERE hidden_at IS NOT NULL AND ($1::uuid IS NULL OR id > $1)
        ORDER BY id LIMIT $2`,
      [progress.lastPostId, PAGE_SIZE],
    );
    return rows.map((r) => r.id);
  });
  for (const id of postIds) {
    await applyMediaVisibilityChange(env, ctx, { subject: "post", subjectId: id, hidden: true });
  }

  const commentIds = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM comments
        WHERE hidden_at IS NOT NULL AND ($1::uuid IS NULL OR id > $1)
        ORDER BY id LIMIT $2`,
      [progress.lastCommentId, PAGE_SIZE],
    );
    return rows.map((r) => r.id);
  });
  for (const id of commentIds) {
    await applyMediaVisibilityChange(env, ctx, { subject: "comment", subjectId: id, hidden: true });
  }

  // A page smaller than PAGE_SIZE means that table has nothing left AFTER the
  // cursor. Both empty (or short) -> the whole sweep is done.
  const donePosts = postIds.length < PAGE_SIZE;
  const doneComments = commentIds.length < PAGE_SIZE;
  const completed = donePosts && doneComments;

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(
      `UPDATE media_backfill_progress
          SET last_post_id = COALESCE($1, last_post_id),
              last_comment_id = COALESCE($2, last_comment_id),
              completed_at = CASE WHEN $3 THEN now() ELSE completed_at END
        WHERE id`,
      [postIds.at(-1) ?? null, commentIds.at(-1) ?? null, completed],
    ),
  );

  if (postIds.length > 0 || commentIds.length > 0 || completed) {
    console.log(
      `backfill-hidden-media: ${postIds.length} post(s), ${commentIds.length} comment(s) this batch` +
        (completed ? " — SWEEP COMPLETE" : ""),
    );
  }
  return { posts: postIds.length, comments: commentIds.length, completed };
}

/** For `POST /admin/backfill-hidden-media` — a manual re-run drives every remaining page in one call. */
export async function backfillHiddenMedia(env: Env, ctx: ExecutionContext): Promise<{ posts: number; comments: number }> {
  let totalPosts = 0;
  let totalComments = 0;
  for (;;) {
    const batch = await runOneBatch(env, ctx);
    totalPosts += batch.posts;
    totalComments += batch.comments;
    if (batch.completed || (batch.posts === 0 && batch.comments === 0)) break;
  }
  return { posts: totalPosts, comments: totalComments };
}
