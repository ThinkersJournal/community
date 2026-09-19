import { reapUnverifiedAccounts } from "./auth/reap-unverified";
import { recordDbProbe } from "./health/probe";
import { notFoundResponse } from "./http/errors";
import { reapOrphanMedia } from "./media/reap-orphan-media";
import { processPendingMoves } from "./media/moves";
import { runOneBatch as runMediaBackfillBatch } from "./media/backfill-hidden-media";
import { runEmailDrain } from "./notifications/email-drain";
import { ROUTES } from "./routes";
import { findRoute } from "./routing";

export { UserSecurityDO } from "./durable-objects/UserSecurityDO";
export { NotifyDO } from "./durable-objects/NotifyDO";
export { PostLiveDO } from "./durable-objects/PostLiveDO";

/**
 * ⚠️ THIS FILE ONLY DISPATCHES. Do not add an `if` here: every route belongs in
 * src/routes.ts, which test/route-protection.test.ts imports as its inventory —
 * a route dispatched from here would be invisible to it. That test asserts this
 * file's shape for exactly that reason.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const match = findRoute(ROUTES, request.method, pathname);
    if (match === null) return notFoundResponse();
    return await match.route.handler(request, env, ctx, match.params);
  },
  /*
   * Five cron patterns, one dispatcher. `30 3 * * *` is the unverified-account
   * reaper (handle-at-signup Task 8), `15 4 * * *` is the orphan-media
   * reclaimer (content-deletion + media-reclamation, Task 4), and `20 4 * * *`
   * is the #61 media-move retry (src/media/moves.ts's processPendingMoves,
   * for a public<->restricted move a prior attempt left pending or failed) —
   * three EXPLICIT, EXCLUSIVE branches, all checked BEFORE the email-drain
   * dispatch below, because that dispatch otherwise treats every non-`0 14`
   * cron as the INSTANT drain. The two-minute pattern below is special: it
   * ALSO drives the #61 backfill batch (src/media/backfill-hidden-media.ts's
   * runOneBatch) — that branch does NOT `return`, so it runs ALONGSIDE the
   * instant drain below, not instead of it. The remaining two patterns are
   * the email outbox drains
   * (M2.3c): the daily pattern drains DIGEST-disposition rows, every other
   * pattern drains INSTANT. A THIN dispatcher, like `fetch` above — the reap,
   * the reclaim, the move retry, the backfill batch and the drain themselves
   * live in src/auth/reap-unverified.ts, src/media/reap-orphan-media.ts,
   * src/media/moves.ts, src/media/backfill-hidden-media.ts and
   * src/notifications/email-drain.ts.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    /*
     * DB-reachability heartbeat (db-health-probe), on EVERY cron tick, not
     * just one pattern, so the probe log never has a gap wider than the
     * shortest configured cron interval. waitUntil so it can never block or
     * break the tick's real work below; recordDbProbe itself never throws.
     * The logic lives in src/health/probe.ts — this file only dispatches.
     */
    ctx.waitUntil(recordDbProbe(env, ctx));

    if (controller.cron === "30 3 * * *") {
      ctx.waitUntil(reapUnverifiedAccounts(env, ctx));
      return;
    }
    if (controller.cron === "15 4 * * *") {
      ctx.waitUntil(reapOrphanMedia(env, ctx));
      return;
    }
    if (controller.cron === "20 4 * * *") {
      ctx.waitUntil(processPendingMoves(env, ctx));
      return;
    }
    /*
     * #61's one-off backfill rides every two-minute tick, ALONGSIDE (not
     * instead of) the instant email drain below — see
     * src/media/backfill-hidden-media.ts's header for why this can't wait for
     * an admin to run it by hand or for the once-daily move-retry cron above.
     * A cheap no-op read once the sweep's completed_at is set, so leaving
     * this on the two-minute cron forever is free.
     */
    if (controller.cron === "*/2 * * * *") {
      ctx.waitUntil(runMediaBackfillBatch(env, ctx));
    }
    const disposition = controller.cron === "0 14 * * *" ? "digest" : "instant";
    ctx.waitUntil(runEmailDrain(env, ctx, disposition));
  },
} satisfies ExportedHandler<Env>;
