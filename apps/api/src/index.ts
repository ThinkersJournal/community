import { notFoundResponse } from "./http/errors";
import { ROUTES } from "./routes";
import { findRoute } from "./routing";

export { UserSecurityDO } from "./durable-objects/UserSecurityDO";

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
} satisfies ExportedHandler<Env>;
