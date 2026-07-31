/**
 * Advance the caller's BADGE watermark (M2.3c). Opening the bell calls this
 * instead of marking everything read: seen_at drives the unread badge, read_at
 * (set only on click-through) drives email suppression. Upsert + a content-free
 * "read" DO nudge (gated on rowCount) so the caller's OTHER tabs clear too.
 */
import { runMutatingPipeline } from "../auth/pipeline";
import { withClient } from "../db/client";

export async function handleMarkSeen(
  request: Request, env: Env, ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: false });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const changed = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const res = await c.query(
      `INSERT INTO notification_prefs (user_id, seen_at, updated_at)
       VALUES ($1, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET seen_at = now(), updated_at = now()`,
      [userId],
    );
    return res.rowCount ?? 0;
  });

  if (changed > 0) {
    ctx.waitUntil(
      (async () => {
        try {
          await env.NOTIFY.getByName(userId).push("read");
        } catch (err) {
          console.error("seen push failed", err);
        }
      })(),
    );
  }
  return new Response(JSON.stringify({}), {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
