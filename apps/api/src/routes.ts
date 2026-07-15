/**
 * THE ROUTE TABLE — the single inventory of everything this Worker answers.
 *
 * ⚠️ EVERY ROUTE GOES HERE, and test/route-protection.test.ts IMPORTS this
 * array. A new mutating route is therefore held to default-deny (no Origin ->
 * 403, no session -> 401) from the moment it is added, whether or not anyone
 * thought about that file. If it runs `runMutatingPipeline`, it passes. If it
 * does not, it fails there — and the only way to make it pass without the
 * pipeline is to add it to PIPELINE_EXEMPT, which is a reviewable security
 * decision with a documented justification, not an omission.
 *
 * ⚠️ test/error-envelope.test.ts ALSO imports this array, for the same reason:
 * every route here must either produce a `{code, message?}` error under a
 * generic probe or be explicitly allowlisted as having no error path. Adding a
 * route without touching either file is safe; adding one that hand-rolls
 * `new Response("nope", { status: 400 })` is not.
 */
import { notFoundResponse } from "./http/errors";
import { handleTestRoute } from "./routes/__test";
import { handleCsrf } from "./routes/csrf";
import { handleLogin } from "./routes/login";
import { handleLogout, handleLogoutAll } from "./routes/logout";
import { handleCreatePost, handleListPosts } from "./routes/posts";
import { handleSignup } from "./routes/signup";
import { handleVerifyEmail } from "./routes/verify-email";

import type { RouteDef } from "./routing";

export const ROUTES: readonly RouteDef[] = [
  { method: "GET", pattern: "/health", handler: async () => new Response("ok", { status: 200 }) },

  // ⚠️ Signup and login do NOT run the mutating pipeline (src/auth/pipeline.ts)
  // — they are how a session comes to exist, so its "401 if no session" step
  // would reject every one of them. Each performs its own `checkOrigin` + rate
  // limiting inline. See the pipeline's header and PIPELINE_EXEMPT in
  // test/route-protection.test.ts.
  { method: "POST", pattern: "/auth/signup", handler: handleSignup },
  { method: "POST", pattern: "/auth/login", handler: handleLogin },

  // Unlike signup/login these DO run the pipeline — they have a session — but
  // WITHOUT `requireVerifiedEmail`: an unverified user must still be able to
  // end their own session. See src/routes/logout.ts.
  { method: "POST", pattern: "/auth/logout", handler: handleLogout },
  { method: "POST", pattern: "/auth/logout-all", handler: handleLogoutAll },

  // Delivers the CSRF token for the caller's session to the `web` Worker. NOT
  // the pipeline (and it must not be): the pipeline's CSRF step would require
  // the very token this route issues. See src/routes/csrf.ts.
  { method: "GET", pattern: "/auth/csrf", handler: handleCsrf },

  // Likewise NOT the pipeline: a GET carries no session/CSRF/epoch requirement.
  // This route authenticates INLINE (session + token ownership + epoch) for its
  // own reasons — see its header; do not weaken it.
  { method: "GET", pattern: "/verify-email", handler: handleVerifyEmail },

  // Content routes. `POST /posts` runs the full mutating pipeline, applied
  // inside the handler so the route owns its own opt-ins. GET is deliberately
  // NOT gated: reads stay open.
  { method: "GET", pattern: "/posts", handler: handleListPosts },
  { method: "POST", pattern: "/posts", handler: handleCreatePost },

  // TEST-ONLY. `handleTestRoute` returns null when `TEST_ROUTES` is unset (i.e.
  // in production), and we fall through to the SAME notFoundResponse() every
  // unmatched path gets — so the route is indistinguishable from one that does
  // not exist. Do not turn this into a 403. See src/routes/__test.ts.
  {
    method: "GET",
    pattern: "/__test/last-verify-token",
    handler: async (request, env) => (await handleTestRoute(request, env)) ?? notFoundResponse(),
  },
];
