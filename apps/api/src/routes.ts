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
import { handleCreateComment, handleDeleteComment, handleUpdateComment } from "./routes/comments";
import { handlePublicComments } from "./routes/comments-public";
import { handleCsrf } from "./routes/csrf";
import { handleFeed } from "./routes/feed";
import { handleFollow, handleFollowStatus, handleUnfollow } from "./routes/follows";
import { handleLogin } from "./routes/login";
import { handleLogout, handleLogoutAll } from "./routes/logout";
import { handleUploadMedia } from "./routes/media";
import { handleMarkSeen } from "./notifications/seen";
import {
  handleListNotifications,
  handleMarkRead,
  handleUnreadCount,
} from "./routes/notifications";
import { handleNotificationsWs } from "./routes/notifications-ws";
import { handleGetNotificationPrefs, handlePutNotificationPrefs } from "./routes/notification-prefs";
import { handleCreatePost, handleGetPost, handleUpdatePost } from "./routes/posts";
import { handlerPostsLive } from "./routes/posts-live";
import {
  handlePublicPost,
  handlePublicProfile,
  handlePublicRecent,
} from "./routes/public";
import {
  handleAddReaction,
  handleMyReactions,
  handlePublicReactions,
  handleRemoveReaction,
} from "./routes/reactions";
import { handleResendVerification } from "./routes/resend-verification";
import { handleSignup } from "./routes/signup";
import {
  handlePublicAuthors,
  handlePublicFollowers,
  handlePublicFollowing,
  handlePublicSocial,
} from "./routes/social-public";
import { handleUnsub } from "./routes/unsub";
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

  // One-click unsubscribe (M2.3c). Token-authed, NOT the mutating pipeline — no
  // session/CSRF (a mail provider's cross-origin one-click). PIPELINE_EXEMPT.
  { method: "POST", pattern: "/unsub", handler: handleUnsub },

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

  // ⚠️ MUST come before `GET /posts/:id` below — `/live` is a literal segment
  // under the SAME first path component, and `findRoute` is first-match-wins
  // (see routing.ts's header). Registering it after would let `:id` capture
  // "live" and shadow this route with the session-gated author-post handler.
  //
  // The unauthenticated per-post live-update channel (M2.3b-live) — Origin-
  // checked (WS carries cookies, bypasses CORS) but deliberately NOT session-
  // gated: the post is public, its frames are content-free ({type} only), and
  // any viewer of a public post may subscribe. See src/routes/posts-live.ts.
  { method: "GET", pattern: "/posts/live", handler: handlerPostsLive },
  { method: "GET", pattern: "/posts/:id", handler: handleGetPost },

  // Durable-handle onboarding + the viewer's own profile state (M2.1).
  { method: "POST", pattern: "/profile/username", handler: handleChooseUsername },
  { method: "GET", pattern: "/profile/me", handler: handleGetMe },

  // Social-graph writes (M2.1). The literal `DELETE /follows/:followeeId` and
  // `POST /follows` share a first segment; no dynamic-vs-literal shadowing
  // exists here (different methods).
  { method: "POST", pattern: "/follows", handler: handleFollow },
  { method: "DELETE", pattern: "/follows/:followeeId", handler: handleUnfollow },

  // The viewer's own follow status for a batch of ids (M2.1). A GET literal —
  // no dynamic-vs-literal shadowing risk with `DELETE /follows/:followeeId`
  // above (different methods) or `POST /follows` (different method).
  { method: "GET", pattern: "/follows/status", handler: handleFollowStatus },

  // The viewer's own reaction toggles for a post + its comments (M2.2) —
  // session-read GET, like /follows/status above. See
  // src/routes/reactions.ts's handleMyReactions.
  { method: "GET", pattern: "/reactions/mine", handler: handleMyReactions },

  // Engagement writes (M2.2). Comment writes purge `post:<id>` — see
  // src/routes/comments.ts's header. PATCH/DELETE own their gates per-handler.
  { method: "POST", pattern: "/comments", handler: handleCreateComment },
  { method: "PATCH", pattern: "/comments/:id", handler: handleUpdateComment },
  { method: "DELETE", pattern: "/comments/:id", handler: handleDeleteComment },

  // Reaction toggles (M2.2) — idempotent both directions, NEITHER purges (spec
  // decision 5). See src/routes/reactions.ts's header.
  { method: "POST", pattern: "/reactions", handler: handleAddReaction },
  { method: "DELETE", pattern: "/reactions", handler: handleRemoveReaction },

  // Per-viewer home feed (M2.1) — no-store, never edge-cached.
  { method: "GET", pattern: "/feed", handler: handleFeed },

  // In-app notifications (M2.3a). List + count are session-read GETs; read is a
  // mutating POST (no verified-email gate — clearing your own bell). All scope
  // to recipient_id = session.userId in-query (IDOR boundary).
  { method: "GET", pattern: "/notifications", handler: handleListNotifications },
  { method: "GET", pattern: "/notifications/unread-count", handler: handleUnreadCount },
  { method: "POST", pattern: "/notifications/read", handler: handleMarkRead },

  // Bell BADGE watermark (M2.3c). Opening the bell advances seen_at (clears the
  // badge) via this mutating POST WITHOUT requireVerifiedEmail — same "clear
  // your own bell" reasoning as /notifications/read. A literal segment under
  // /notifications/*, no dynamic-shadow risk. See src/notifications/seen.ts.
  { method: "POST", pattern: "/notifications/seen", handler: handleMarkSeen },

  // Realtime bell upgrade (M2.3b) — a session-read GET, like
  // /notifications/unread-count above, that authenticates inline (origin +
  // session) and forwards the upgrade to the caller's OWN NotifyDO
  // (getByName(session.userId), never a client-supplied id). See
  // src/routes/notifications-ws.ts. The spike's unauthed `/notifications/ws`
  // and its `/notifications/ws-push` trigger (M2.3b Task 0) are gone — replaced
  // by this authed route and (in later tasks) real notify()/mark-read pushes.
  { method: "GET", pattern: "/notifications/ws", handler: handleNotificationsWs },

  // Notification email preferences (M2.3c). GET is a session read; PUT runs the
  // mutating pipeline (verified-email NOT required — opting out must stay open to
  // the unverified). Both scope to session.userId in-query.
  { method: "GET", pattern: "/notification-prefs", handler: handleGetNotificationPrefs },
  { method: "PUT", pattern: "/notification-prefs", handler: handlePutNotificationPrefs },

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

  // ANONYMOUS social reads (M2.1) — see src/routes/social-public.ts's header:
  // viewer-independent like the routes above, but NOT edge-cached (they change
  // on every follow), so HYPERDRIVE_FRESH with no cache-tag.
  //
  // ⚠️ `GET /public/comments` lives HERE, not in the edge-cached block above:
  // its handler (src/routes/comments-public.ts) reads HYPERDRIVE_FRESH with no
  // cache-tag, same as the social reads beside it — it is NOT edge-cached.
  { method: "GET", pattern: "/public/social", handler: handlePublicSocial },
  { method: "GET", pattern: "/public/followers", handler: handlePublicFollowers },
  { method: "GET", pattern: "/public/following", handler: handlePublicFollowing },
  { method: "GET", pattern: "/public/authors", handler: handlePublicAuthors },
  { method: "GET", pattern: "/public/comments", handler: handlePublicComments },

  // Public reaction counts (M2.2) — anonymous, zero-filled per kind for the
  // post and every comment on it. Same NOT-edge-cached shelf as the social
  // reads above: HYPERDRIVE_FRESH, no cache-tag. See src/routes/reactions.ts.
  { method: "GET", pattern: "/public/reactions", handler: handlePublicReactions },

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
