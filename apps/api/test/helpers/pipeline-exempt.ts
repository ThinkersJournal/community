/**
 * Shared by test/route-protection.test.ts (default-deny) and
 * test/pipeline-barred.test.ts (issue #50): both enumerate ROUTES minus this
 * set, so the two suites cover the SAME population of pipeline routes.
 */

/**
 * The non-GET routes that legitimately do NOT run the mutating pipeline.
 *
 * ⚠️ ADDING TO THIS SET IS A SECURITY DECISION. It is not a way to quiet a
 * failing test — it is an assertion that the route cannot use the pipeline AND
 * that it defends itself some other way. Both entries here are the same case:
 * signup and login are how a session comes to EXIST, so they have none at
 * request time and the pipeline's step 2 would 401 every one of them (its
 * header spells this out). They are not unprotected — each runs `checkOrigin`
 * INLINE, plus its own rate limiting (and, for signup, Turnstile) — and the
 * `exempt routes` block below pins exactly that, so an exemption still buys a
 * route a real assertion rather than a pass.
 *
 * If you are here because you added a route: the answer is almost certainly to
 * call `runMutatingPipeline` in its handler, not to add it here.
 */
export const PIPELINE_EXEMPT: ReadonlySet<string> = new Set([
  "POST /auth/signup",
  "POST /auth/login",
  // #70 password reset — no session exists yet at either step (that is the
  // whole reason these routes exist: a user who cannot authenticate).
  // `forgot-password` runs inline `checkOrigin` + its own two-bucket rate
  // limit, same shape as signup/login. `reset-password` runs inline
  // `checkOrigin` only — no rate limit, because token entropy (not request
  // volume) is its defense, the same reasoning `GET /verify-email` already
  // relies on. See both routes' own headers.
  "POST /auth/forgot-password",
  "POST /auth/reset-password",
  // spec §8 — unauthenticated by design (decision #6); inline checkOrigin +
  // DSA_LIMITER + Turnstile.
  "POST /dsa-notice",
  // Confirmation half (Task 3) — same unauthenticated-by-design reasoning: a
  // reporter who filed the notice above still has no session. Inline
  // checkOrigin, same as the intake route.
  "POST /dsa-notice/confirm",
  // Token-authed one-click unsubscribe (M2.3c, RFC 8058): cross-origin, no
  // session/CSRF by design — a mail provider's one-click POST carries no cookie,
  // so the HMAC token IS the auth (see src/routes/unsub.ts). Unlike signup/login
  // it deliberately runs NO checkOrigin either (a mail client cannot forge one,
  // and its only effect is master_enabled=false for the token's own user), so it
  // is NOT asserted by the `exempt routes enforce checkOrigin inline` block
  // below — it is excluded there explicitly with the same justification.
  "POST /unsub",
  // TEST-ONLY (handle-at-signup Task 8): a debug seam gated on TEST_ROUTES ===
  // "1" (see src/routes/__test.ts), reachable only in dev/test — it has no
  // session by design, so the pipeline's step 2 would 401 every call. UNLIKE
  // /unsub above it DOES run an inline `checkOrigin` (there is no bearer token
  // to substitute for one here), so it is asserted by the `exempt routes
  // enforce checkOrigin inline` block below, not excluded from it.
  "POST /__test/reap-unverified",
  // TEST-ONLY (content-deletion + media-reclamation, Task 4): the same
  // TEST_ROUTES-gated debug seam shape as reap-unverified above, for the daily
  // orphan-media reclaimer (src/media/reap-orphan-media.ts). Same reasoning,
  // same inline `checkOrigin`.
  "POST /__test/reap-orphan-media",
  // TEST-ONLY (board item 59 = Option C): the same TEST_ROUTES-gated debug
  // seam shape as the two reapers above, for the daily account-anonymisation
  // reaper (src/auth/anonymise-accounts.ts). Same reasoning, same inline
  // `checkOrigin`.
  "POST /__test/anonymise-accounts",
  // The Access-gated moderation decision (M4 2b-ii). Cannot use
  // `runMutatingPipeline`: that authenticates a MEMBER SESSION, and an admin is
  // an Access principal — a different trust domain, and a member session confers
  // no admin authority. It defends itself instead with an inline `checkOrigin`
  // (see handleAdminDecision), which is required because Cloudflare injects the
  // Access assertion from the CF_Authorization COOKIE: without it, a cross-site
  // form post from a logged-in moderator's browser would carry a valid
  // assertion and drive a real content decision.
  "POST /admin/decision",
  // #61's two-person media-access grant — same Access trust domain and same
  // reasoning as /admin/decision above (Access is a different principal than
  // a member session; each defends itself with an inline `checkOrigin`).
  "POST /admin/media-access-requests",
  "POST /admin/media-access-requests/:id/approve",
  "POST /admin/backfill-hidden-media",
  // #113 — same Access + inline checkOrigin defense as /admin/decision.
  "POST /admin/accounts/:handle/actions",
  // Addendum to #113 (PM ruling, 2026-10-01) — same Access trust domain and
  // same reasoning as /admin/decision/media-access-requests above.
  "POST /admin/dsa-notices/:id/close",
  // account-legal-hold spec §3 T3 (manual impose/release) — same Access trust
  // domain and inline checkOrigin defense as /admin/accounts/:handle/actions
  // directly above.
  "POST /admin/accounts/:handle/holds",
  "POST /admin/accounts/:handle/holds/:id/release",
  // #113 — no session exists for a barred appellant; inline checkOrigin, single-use token.
  "POST /appeals/by-token",
  // #50 Q4 — barred users have no session; inline checkOrigin; token / Turnstile+rate limit.
  "POST /account/delete-request",
  "POST /account/delete-request/resend",
  // #113 plan B — same Access + inline checkOrigin defense as /admin/decision.
  "POST /admin/appeals/:id/resolve",
]);
