import { handleTestRoute } from "./routes/__test";
import { handleCreatePost, handleListPosts } from "./routes/posts";
import { handleVerifyEmail } from "./routes/verify-email";

export { UserSecurityDO } from "./durable-objects/UserSecurityDO";

/** The one 404 every unmatched path gets — see the note in routes/__test.ts. */
function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "GET" && pathname === "/verify-email") {
      return await handleVerifyEmail(request, env, ctx);
    }

    // Content routes (M1 stub — Task 13 wires just enough to exercise the
    // soft email-verification gate; Task 16 replaces this with the full
    // mutating pipeline). GET is deliberately NOT gated: reads stay open.
    if (request.method === "GET" && pathname === "/posts") {
      return await handleListPosts();
    }
    if (request.method === "POST" && pathname === "/posts") {
      return await handleCreatePost(request, env, ctx);
    }

    // TEST-ONLY routes. `handleTestRoute` returns null when `TEST_ROUTES` is
    // unset (i.e. in production) — falling through to the SAME `notFound()`
    // every other unmatched path gets, so the route is indistinguishable from
    // one that does not exist. Do not turn this into a 403.
    if (pathname.startsWith("/__test/")) {
      const response = await handleTestRoute(request, env);
      if (response !== null) {
        return response;
      }
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
