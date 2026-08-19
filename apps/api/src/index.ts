import { reapUnverifiedAccounts } from "./auth/reap-unverified";
import { recordDbProbe } from "./health/probe";
import { notFoundResponse } from "./http/errors";
import { reapOrphanMedia } from "./media/reap-orphan-media";
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
   * Four cron patterns, one dispatcher. `30 3 * * *` is the unverified-account
   * reaper (handle-at-signup Task 8) and `15 4 * * *` is the orphan-media
   * reclaimer (content-deletion + media-reclamation, Task 4) — two EXPLICIT
   * branches, both checked BEFORE the email-drain dispatch below, because that
   * dispatch otherwise treats every non-`0 14` cron as the INSTANT drain. The
   * other two patterns are the email outbox drains (M2.3c): the daily pattern
   * drains DIGEST-disposition rows, every other pattern drains INSTANT. A THIN
   * dispatcher, like `fetch` above — the reap, the reclaim and the drain
   * themselves live in src/auth/reap-unverified.ts,
   * src/media/reap-orphan-media.ts and src/notifications/email-drain.ts.
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
    const disposition = controller.cron === "0 14 * * *" ? "digest" : "instant";
    ctx.waitUntil(runEmailDrain(env, ctx, disposition));
  },
} satisfies ExportedHandler<Env>;
