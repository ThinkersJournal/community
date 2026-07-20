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
import { handleFollow, handleUnfollow } from "./routes/follows";
import { handleLogin } from "./routes/login";
import { handleLogout, handleLogoutAll } from "./routes/logout";
import { handleUploadMedia } from "./routes/media";
import { handleCreatePost, handleGetPost, handleUpdatePost } from "./routes/posts";
import {
  handlePublicPost,
  handlePublicProfile,
  handlePublicRecent,
} from "./routes/public";
import { handleResendVerification } from "./routes/resend-verification";
import { handleSignup } from "./routes/signup";
import { handleChooseUsername, handleGetMe } from "./routes/username";
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

  // Same story as logout: a session, but deliberately WITHOUT
  // `requireVerifiedEmail` — this route exists FOR the unverified, so gating it
  // on verification would be a catch-22. See src/routes/resend-verification.ts.
  { method: "POST", pattern: "/auth/resend-verification", handler: handleResendVerification },

  // Delivers the CSRF token for the caller's session to the `web` Worker. NOT
  // the pipeline (and it must not be): the pipeline's CSRF step would require
  // the very token this route issues. See src/routes/csrf.ts.
  { method: "GET", pattern: "/auth/csrf", handler: handleCsrf },

  // Likewise NOT the pipeline: a GET carries no session/CSRF/epoch requirement.
  // This route authenticates INLINE (session + token ownership + epoch) for its
  // own reasons — see its header; do not weaken it.
  { method: "GET", pattern: "/verify-email", handler: handleVerifyEmail },

  // AUTHOR-facing content routes (src/routes/posts.ts). Each runs the mutating
  // pipeline inside its own handler, so the route owns its opt-ins — all three
  // are content mutation and therefore take `requireVerifiedEmail`. `GET
  // /posts/:id` is the author's own post (drafts included) and authenticates via
  // `readCurrentSession`; the ANONYMOUS reads are the /public/* routes below.
  //
  // ⚠️ M0's `GET /posts` stub feed is GONE, not moved. It answered a literal
  // `{posts: []}`; the real public listing is `GET /public/profile`. A route that
  // lies is worse than one that does not exist.
  { method: "POST", pattern: "/posts", handler: handleCreatePost },
  { method: "PATCH", pattern: "/posts/:id", handler: handleUpdatePost },
  { method: "GET", pattern: "/posts/:id", handler: handleGetPost },

  // Durable-handle onboarding + the viewer's own profile state (M2.1).
  { method: "POST", pattern: "/profile/username", handler: handleChooseUsername },
  { method: "GET", pattern: "/profile/me", handler: handleGetMe },

  // Social-graph writes (M2.1). The literal `DELETE /follows/:followeeId` and
  // `POST /follows` share a first segment; no dynamic-vs-literal shadowing
  // exists here (different methods).
  { method: "POST", pattern: "/follows", handler: handleFollow },
  { method: "DELETE", pattern: "/follows/:followeeId", handler: handleUnfollow },

  // ANONYMOUS reads — what the edge caches. See src/routes/public.ts's header:
  // no session is read here, by construction.
  //
  // ⚠️ These are LITERAL paths under /public/, so they cannot be shadowed by
  // `/posts/:id` above (different first segment). If a literal `/posts/<word>`
  // route is ever added it MUST be registered BEFORE `/posts/:id` — `findRoute`
  // is first-match-wins, and route-protection.test.ts fails loudly if it is not.
  { method: "GET", pattern: "/public/posts", handler: handlePublicPost },
  { method: "GET", pattern: "/public/profile", handler: handlePublicProfile },
  { method: "GET", pattern: "/public/recent", handler: handlePublicRecent },

  // The image upload pipeline: sniff -> cross-check -> quota -> transform to
  // WebP -> content-addressed R2 -> row. Takes RAW image bytes as the body, not
  // multipart — see src/routes/media.ts's header.
  { method: "POST", pattern: "/media", handler: handleUploadMedia },

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
