import { handleTestRoute } from "./routes/__test";
import { handleCsrf } from "./routes/csrf";
import { handleLogin } from "./routes/login";
import { handleLogout, handleLogoutAll } from "./routes/logout";
import { handleCreatePost, handleListPosts } from "./routes/posts";
import { handleSignup } from "./routes/signup";
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

    // ⚠️ Signup and login do NOT run the mutating pipeline
    // (src/auth/pipeline.ts) — they are how a session comes to exist, so its
    // "401 if no session" step would reject every one of them. Each performs
    // its own `checkOrigin` + rate limiting inline. See the pipeline's header.
    if (request.method === "POST" && pathname === "/auth/signup") {
      return await handleSignup(request, env, ctx);
    }

    if (request.method === "POST" && pathname === "/auth/login") {
      return await handleLogin(request, env, ctx);
    }

    // Unlike signup/login, these DO run the mutating pipeline — they have a
    // session — but WITHOUT `requireVerifiedEmail`: an unverified user must
    // still be able to end their own session. See src/routes/logout.ts.
    if (request.method === "POST" && pathname === "/auth/logout") {
      return await handleLogout(request, env, ctx);
    }

    if (request.method === "POST" && pathname === "/auth/logout-all") {
      return await handleLogoutAll(request, env, ctx);
    }

    // Delivers the CSRF token for the caller's session to the `web` Worker,
    // which embeds it in the HTML it renders. NOT the pipeline (and it must not
    // be): the pipeline's CSRF step would require the very token this route
    // issues. See src/routes/csrf.ts for why a GET is the right shape here.
    if (request.method === "GET" && pathname === "/auth/csrf") {
      return await handleCsrf(request, env);
    }

    // Likewise NOT the pipeline: a GET carries no session/CSRF/epoch
    // requirement. This route authenticates INLINE (session + token ownership
    // + epoch) for its own reasons — see its header; do not weaken it.

    if (request.method === "GET" && pathname === "/verify-email") {
      return await handleVerifyEmail(request, env, ctx);
    }

    // Content routes (M1 stubs). `POST /posts` runs the full mutating
    // pipeline (origin -> session -> CSRF -> epoch -> verified-email), applied
    // inside the handler so the route owns its own opt-ins. GET is
    // deliberately NOT gated: reads stay open.
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
