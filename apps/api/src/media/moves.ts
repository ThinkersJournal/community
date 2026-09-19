/**
 * The durable move between `env.MEDIA` (public) and `env.MEDIA_RESTRICTED`
 * (private) — issue #61.
 *
 * ⚠️ DURABILITY FIRST: a `media_moves` row is inserted `pending` BEFORE the R2
 * work starts, so a Worker that dies mid-move (or an R2 call that fails)
 * leaves a row the retry cron (`processPendingMoves`) will pick up and finish
 * — the failure mode is "retried later", never "silently stays public
 * forever" (PM's review, item 3).
 *
 * ⚠️ ORDER PER MOVE: copy to target -> delete from source -> purge the CDN
 * URL. Copying first means a reader never sees the object briefly missing
 * from BOTH buckets; deleting from the public bucket is the step that
 * actually closes the exposure, so it happens before the (cheaper, retriable
 * on its own) cache purge.
 *
 * `attemptMove` is called once, inline, right after the visibility write that
 * triggered it (so the common case purges immediately, per CireSnave's
 * standing §5.3 rule). `processPendingMoves` is the cron fallback for
 * whichever step failed.
 */
import { purgeMediaUrls } from "../cache/purge-url";
import { withClient } from "../db/client";

const MAX_ATTEMPTS = 8;

export type MoveDirection = "to_restricted" | "to_public";

function bucketsFor(env: Env, direction: MoveDirection): { from: R2Bucket; to: R2Bucket } {
  return direction === "to_restricted"
    ? { from: env.MEDIA, to: env.MEDIA_RESTRICTED }
    : { from: env.MEDIA_RESTRICTED, to: env.MEDIA };
}

/** Inserts the durable row, then attempts the move inline. Never throws. */
export async function enqueueAndAttemptMove(
  env: Env,
  ctx: ExecutionContext,
  r2Key: string,
  direction: MoveDirection,
): Promise<void> {
  const moveId = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO media_moves (r2_key, direction) VALUES ($1, $2) RETURNING id`,
      [r2Key, direction],
    );
    return rows[0]!.id;
  });
  await runMove(env, ctx, moveId, r2Key, direction);
}

async function runMove(
  env: Env,
  ctx: ExecutionContext,
  moveId: string,
  r2Key: string,
  direction: MoveDirection,
): Promise<void> {
  const { from, to } = bucketsFor(env, direction);
  try {
    // Object already gone from `from` (a prior attempt got past the delete
    // step but died before COMMITting `done`) — `get` on the SOURCE would
    // fail; check `to` first so a retry is idempotent rather than fatal.
    const alreadyMoved = await to.head(r2Key);
    if (alreadyMoved === null) {
      const source = await from.get(r2Key);
      if (source === null) {
        // Neither bucket has it — the object was reaped, or this is a stale
        // retry of an already-completed move whose `to` head check raced.
        // Nothing left to move; mark done rather than fail forever.
        await markDone(env, ctx, moveId);
        return;
      }
      await to.put(r2Key, source.body, { httpMetadata: source.httpMetadata });
    }
    await from.delete(r2Key);
    await purgeMediaUrls(env, [r2Key]);
    await markDone(env, ctx, moveId);
  } catch (err) {
    await markFailed(env, ctx, moveId, err);
  }
}

async function markDone(env: Env, ctx: ExecutionContext, moveId: string): Promise<void> {
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(`UPDATE media_moves SET status = 'done', updated_at = now() WHERE id = $1`, [moveId]),
  );
}

async function markFailed(env: Env, ctx: ExecutionContext, moveId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error("media move failed", moveId, message);
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(
      `UPDATE media_moves
          SET attempts = attempts + 1,
              last_error = $2,
              status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
              updated_at = now()
        WHERE id = $1`,
      [moveId, message.slice(0, 500), MAX_ATTEMPTS],
    ),
  );
}

/**
 * The retry cron. Oldest-pending-first, one at a time — moves are rare
 * (a hide/restore event, not a hot path), so there is no batching win worth
 * the added complexity.
 */
export async function processPendingMoves(env: Env, ctx: ExecutionContext): Promise<number> {
  const pending = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ id: string; r2_key: string; direction: MoveDirection }>(
      `SELECT id, r2_key, direction FROM media_moves WHERE status = 'pending' ORDER BY created_at LIMIT 100`,
    );
    return rows;
  });
  for (const row of pending) {
    await runMove(env, ctx, row.id, row.r2_key, row.direction);
  }
  const failedCount = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM media_moves WHERE status = 'failed'`,
    );
    return Number(rows[0]!.count);
  });
  // A move `failed` (exhausted MAX_ATTEMPTS) means an object may STILL be
  // public when it should not be — this must be loud, same reasoning as
  // cache/purge.ts's own "alerting is a deploy-gate item" note.
  if (failedCount > 0) {
    console.error(`media moves: ${failedCount} row(s) FAILED after ${MAX_ATTEMPTS} attempts — needs manual attention`);
  }
  return pending.length;
}
