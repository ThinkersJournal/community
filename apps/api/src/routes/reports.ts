/**
 * REPORT — a verified member flags a post or comment for review. Idempotent by
 * construction: `INSERT ... ON CONFLICT DO NOTHING` against the migration
 * 0012 `reports_reporter_post_unique` / `reports_reporter_comment_unique`
 * constraints, so a repeat report of the same target by the same reporter is
 * a benign no-op, never an error (mirrors follows.ts's follow edge). Only a
 * genuinely NEW report row (insert `rowCount` > 0) then runs the auto-hide check
 * (src/moderation/auto-hide.ts) — a target drawing >=3 distinct reporters
 * within 24h is hidden pending review. A duplicate (0 rows) cannot change the
 * distinct-reporter count, so re-running the check would be redundant DB load.
 */
import { runMutatingPipeline } from "../auth/pipeline";
import { enforceRateLimit } from "../auth/ratelimit";
import { withClient } from "../db/client";
import { isForeignKeyViolation } from "../db/errors";
import { errorResponse } from "../http/errors";
import { maybeAutoHide } from "../moderation/auto-hide";

import { ReportInput } from "@thinkersjournal/shared";

export async function handleCreateReport(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const limited = await enforceRateLimit(env.REPORT_LIMITER, `report:${userId}`);
  if (limited !== null) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = ReportInput.safeParse(body);
  if (!parsed.success) {
    // INVALID_REPORT_TARGET means the ONE thing it says: not exactly one of
    // postId/commentId — the schema's `.refine()`, which emits a single `custom`
    // issue with this message (and only runs once the object shape parses, so it
    // never coexists with field issues). Every other parse failure (bad reason
    // enum, non-uuid id) is a generic INVALID_INPUT with `fields`, mirroring
    // blocks.ts / comments.ts / reactions.ts.
    const isTargetRefine = parsed.error.issues.some(
      (i) => i.code === "custom" && i.message === "exactly one of postId/commentId",
    );
    if (isTargetRefine) return errorResponse("INVALID_REPORT_TARGET", 400);
    return errorResponse("INVALID_INPUT", 400, {
      fields: parsed.error.issues.map((i) => i.path.join(".")),
    });
  }
  const { postId, commentId, reason } = parsed.data;

  let error: Response | null = null;
  try {
    error = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      // Verify the target exists before writing — mirrors reactions.ts's
      // target-liveness check, and gives a clean 404 rather than leaning on
      // the FK violation (still caught below as a race backstop).
      const table = postId !== undefined ? "posts" : "comments";
      const targetId = postId ?? commentId!;
      const { rows } = await c.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ${table} WHERE id = $1) AS exists`,
        [targetId],
      );
      if (rows[0]?.exists !== true) return errorResponse("NOT_FOUND", 404);

      const { rowCount } = await c.query(
        `INSERT INTO reports (reporter_id, post_id, comment_id, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [userId, postId ?? null, commentId ?? null, reason],
      );

      // Only a genuinely new report can move the distinct-reporter count; a
      // duplicate (ON CONFLICT no-op, rowCount 0) leaves it unchanged, so the
      // auto-hide check would be redundant DB load. Behavior-preserving: the
      // 3rd distinct reporter's insert already ran the check.
      if (rowCount && rowCount > 0) {
        await maybeAutoHide(c, postId !== undefined ? { postId } : { commentId: commentId! });
      }
      return null;
    });
  } catch (err) {
    // Target deleted between the check and the insert -> FK 23503; same
    // answer as "never there" (reactions.ts's handleAddReaction mirrors this).
    if (isForeignKeyViolation(err)) return errorResponse("NOT_FOUND", 404);
    throw err;
  }
  if (error !== null) return error;
  return new Response(null, { status: 201 });
}
