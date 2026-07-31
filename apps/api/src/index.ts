import { notFoundResponse } from "./http/errors";
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
   * The email outbox drains (M2.3c). Two cron patterns, one dispatcher: the daily
   * pattern drains DIGEST-disposition rows, every other pattern drains INSTANT.
   * A THIN dispatcher, like `fetch` above — the drain itself lives in
   * src/notifications/email-drain.ts.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const disposition = controller.cron === "0 14 * * *" ? "digest" : "instant";
    ctx.waitUntil(runEmailDrain(env, ctx, disposition));
  },
} satisfies ExportedHandler<Env>;
