import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
import { errorResponse } from "../src/http/errors";
import { ROUTES } from "../src/routes";

import type { RouteDef } from "../src/routing";

/**
 * THE ERROR-ENVELOPE INVENTORY.
 *
 * ⚠️ WHY THIS FILE EXISTS. Before M1 the api answered errors in FOUR dialects
 * ({error}, {code}, plain text, empty), and apps/web/src/lib/api.ts had to
 * carry a comment warning that a null body is not an error signal. M1 roughly
 * triples the route count; each new route would inherit whichever dialect its
 * neighbour happened to use. This suite makes "every non-2xx is
 * {code, message?}" checkable rather than remembered.
 *
 * It asserts the SHAPE, not the code strings — the individual route suites
 * already pin those (they are a wire contract the web app branches on).
 *
 * ⚠️ WHY IT ENUMERATES ROUTES RATHER THAN A HAND-WRITTEN LIST. This file was
 * born as seven curated `CASES`. That made it exactly the thing its own header
 * claims to abolish: a route that hand-rolled `new Response("nope", { status:
 * 400 })` was caught only if someone REMEMBERED to add a case for it — the
 * "remembered, not checked" failure mode, reproduced inside the check. So
 * coverage is now driven from src/routes.ts, the same table
 * test/route-protection.test.ts uses, in two layers:
 *
 *   1. AUTOMATIC — every mutating route is probed without an `Origin`. Each
 *      must reject (route-protection.test.ts pins that it is a 403, whether via
 *      the pipeline or an inline checkOrigin), and that rejection must carry the
 *      envelope. A new mutating route is covered the moment it is registered,
 *      with no edit here.
 *   2. LEDGERED — a route whose error needs a bespoke request (a body, a param,
 *      a header) is listed in `CASES`; one with genuinely no error path is
 *      listed in `ERROR_FREE` WITH A REASON. `coverage` below fails on any route
 *      that is in neither. The failure mode is therefore "you must say why",
 *      not "nobody noticed".
 */
const ALLOWED_ORIGIN = "http://localhost:8787";

/** `"POST /posts"` — the key shared by CASES, ERROR_FREE, and the test names. */
function label(route: RouteDef): string {
  return `${route.method} ${route.pattern}`;
}

/**
 * Concrete sample values for `:param` segments, so a pattern can be probed as a
 * real URL. Well-formed is all that is required: every probe below is rejected
 * long before a handler could look the value up.
 */
const PARAM_SAMPLES: Readonly<Record<string, string>> = {
  id: "00000000-0000-7000-8000-000000000000",
};

function concretePath(pattern: string): string {
  return pattern
    .split("/")
    .map((s) => (s.startsWith(":") ? (PARAM_SAMPLES[s.slice(1)] ?? "sample") : s))
    .join("/");
}

/**
 * A body that satisfies BOTH `SignupInput` and `LoginInput`, and that every
 * other route ignores — signup/login validate BEFORE their origin check, so a
 * garbage body would 400 there and prove nothing about the origin rejection.
 * (Both statuses carry the envelope, but the probe should exercise the path it
 * claims to.)
 */
function probeBody(): string {
  return JSON.stringify({
    email: `error-envelope-${crypto.randomUUID()}@example.com`,
    password: "correct-horse-battery-staple",
    // Satisfies SignupInput's now-required `username` (Task 1) — LoginInput has
    // no such field and simply ignores the extra key.
    username: `probe${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
    turnstileToken: "dummy-turnstile-token",
  });
}

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** The assertion this whole file exists for. Every probe funnels through it. */
async function expectEnvelope(response: Response): Promise<void> {
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.headers.get("content-type")).toBe("application/json");

  const body: unknown = await response.json();
  expect(
    body,
    "a non-2xx body must be an object carrying a string `code` — see apps/api/src/http/errors.ts. If you are here because you added a route: return errorResponse(...), never a bare string or {error}.",
  ).toEqual(expect.objectContaining({ code: expect.any(String) }));
  // Nothing may smuggle the old dialect back in alongside the new one.
  expect(body).not.toHaveProperty("error");
}

const MUTATING = ROUTES.filter((r) => r.method !== "GET" && r.method !== "HEAD");

/**
 * A bespoke error probe for a route whose failure needs a specific request.
 * `route` is the ROUTES entry it exercises — the key that feeds `coverage`
 * below — or `null` for a probe that deliberately belongs to no route.
 */
interface ErrorCase {
  readonly name: string;
  readonly route: string | null;
  readonly build: () => Request;
}

const CASES: readonly ErrorCase[] = [
  // Belongs to no route ON PURPOSE: this is the router's default, the one 404
  // that src/http/errors.ts requires the gated __test route to be identical to.
  {
    name: "404 unmatched path",
    route: null,
    build: () => new Request("https://api.test/nope"),
  },
  {
    name: "400 malformed JSON",
    route: "POST /auth/signup",
    build: () =>
      new Request("https://api.test/auth/signup", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: "{",
      }),
  },
  {
    name: "400 zod rejection",
    route: "POST /auth/signup",
    build: () =>
      new Request("https://api.test/auth/signup", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: "nope", password: "x", turnstileToken: "t" }),
      }),
  },
  {
    name: "403 rejected origin",
    route: "POST /auth/login",
    build: () =>
      new Request("https://api.test/auth/login", {
        method: "POST",
        headers: { Origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "x" }),
      }),
  },
  {
    name: "401 no session (pipeline step 2)",
    route: "POST /posts",
    build: () =>
      new Request("https://api.test/posts", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ title: "t", markdownSource: "b" }),
      }),
  },
  {
    name: "400 verify-email with no token",
    route: "GET /verify-email",
    build: () => new Request("https://api.test/verify-email"),
  },
  {
    name: "401 csrf route with no session",
    route: "GET /auth/csrf",
    build: () => new Request("https://api.test/auth/csrf"),
  },
  // ⚠️ THE FOUR BELOW ARE WHERE `GET /posts`'s ERROR_FREE CLAIM WENT (Task 9).
  // That claim said the stub feed had no error path — true of a literal
  // `{posts: []}`, and the reason the entry existed. Task 9 deleted the stub
  // outright (the real listing is `GET /public/profile`), so the claim did not
  // become stale, it became MOOT: there is no such route to make a claim about.
  // These are its successors, and each is ledgered by the property the old entry
  // asserted it lacked — a real failure mode, probed.
  {
    name: "401 the author's own post with no session",
    route: "GET /posts/:id",
    build: () =>
      new Request("https://api.test/posts/00000000-0000-7000-8000-000000000000"),
  },
  // GET /profile/me authenticates via readCurrentSession, same as GET
  // /posts/:id above — its only error path (M2.1).
  {
    name: "401 profile/me with no session",
    route: "GET /profile/me",
    build: () => new Request("https://api.test/profile/me"),
  },
  {
    name: "404 public post with no username/slug",
    route: "GET /public/posts",
    build: () => new Request("https://api.test/public/posts"),
  },
  // The UNKNOWN-USERNAME 404, deliberately — not the malformed-cursor 400. The
  // owner lookup runs FIRST, so a probe with both would 404 before the cursor was
  // ever cast, and this case would be named for a path it never took. The cursor
  // 400 needs a real profile to reach; test/public-reads.test.ts owns it, where
  // there is an actor to make one.
  {
    name: "404 public profile with an unknown username",
    route: "GET /public/profile",
    build: () => new Request("https://api.test/public/profile?username=nobody"),
  },
  {
    name: "400 public recent with a malformed limit",
    route: "GET /public/recent",
    build: () => new Request("https://api.test/public/recent?limit=abc"),
  },
  // GET /public/discover (M2.4b) — a malformed cursor is its reachable 400, same
  // shape as /public/profile's malformed-cursor case. See src/routes/public.ts.
  {
    name: "400 public discover with a malformed cursor",
    route: "GET /public/discover",
    build: () => new Request("https://api.test/public/discover?cursor=not-a-uuid"),
  },
  // GET /public/tag (M2.4c) — a blank slug is rejected BEFORE the DB is
  // touched, same "no lookup gating it" shape as /public/authors' and
  // /public/search's cases above. See src/routes/public.ts.
  {
    name: "400 public tag with a blank slug",
    route: "GET /public/tag",
    build: () => new Request("https://api.test/public/tag?slug="),
  },
  // GET /public/social's owner lookup runs first, same shape as GET
  // /public/profile above — an unknown username 404s (M2.1).
  {
    name: "404 public social with an unknown username",
    route: "GET /public/social",
    build: () => new Request("https://api.test/public/social?username=nobody"),
  },
  // The UNKNOWN-USERNAME 404, deliberately — not the malformed-cursor 400, for
  // the same reason as GET /public/profile above: the owner lookup runs FIRST,
  // so a probe with both would 404 before the cursor was ever cast. The cursor
  // 400 needs a real profile to reach; test/social-reads.test.ts owns it.
  {
    name: "404 public followers with an unknown username",
    route: "GET /public/followers",
    build: () => new Request("https://api.test/public/followers?username=nobody"),
  },
  {
    name: "404 public following with an unknown username",
    route: "GET /public/following",
    build: () => new Request("https://api.test/public/following?username=nobody"),
  },
  // GET /public/authors has no username to look up (it lists authors, not a
  // single user's page) — so unlike /public/social|followers|following above,
  // its malformed-cursor 400 is directly reachable with no owner lookup gating
  // it first. Same shape as /public/recent's malformed-limit case below.
  {
    name: "400 public authors with a malformed cursor",
    route: "GET /public/authors",
    build: () => new Request("https://api.test/public/authors?cursor=not-a-uuid"),
  },
  {
    name: "404 public comments without a postId",
    route: "GET /public/comments",
    build: () => new Request("https://api.test/public/comments"),
  },
  {
    name: "404 public reactions without a postId",
    route: "GET /public/reactions",
    build: () => new Request("https://api.test/public/reactions"),
  },
  // GET /public/search (M2.4a) validates q/type/offset BEFORE touching the DB —
  // same "no lookup gating it" shape as /public/authors' malformed-cursor case
  // above. A too-short q is the simplest reachable 400. See src/routes/search.ts.
  {
    name: "400 public search with a too-short q",
    route: "GET /public/search",
    build: () => new Request("https://api.test/public/search?q=a"),
  },
  // GET /follows/status authenticates via readCurrentSession, same as GET
  // /profile/me above — its only error path (M2.1).
  {
    name: "401 follows/status with no session",
    route: "GET /follows/status",
    build: () => new Request("https://api.test/follows/status?id=00000000-0000-7000-8000-000000000000"),
  },
  {
    name: "401 reactions/mine with no session",
    route: "GET /reactions/mine",
    build: () =>
      new Request("https://api.test/reactions/mine?postId=00000000-0000-7000-8000-000000000000"),
  },
  // GET /feed authenticates via readCurrentSession, same as GET /profile/me
  // and GET /follows/status above — its 401 path. The malformed-cursor 400
  // needs a real session to reach (readCurrentSession runs first); that path
  // is owned by test/feed.test.ts, the same split public-reads.test.ts and
  // social-reads.test.ts use for their own cursor 400s.
  {
    name: "401 feed with no session",
    route: "GET /feed",
    build: () => new Request("https://api.test/feed"),
  },
  // GET /notifications and GET /notifications/unread-count authenticate via
  // readCurrentSession, same shape as GET /feed above — their only error path
  // (M2.3a). POST /notifications/read is a mutating route and is already
  // covered by the automatic origin-less-rejection layer.
  {
    name: "401 notifications list no session",
    route: "GET /notifications",
    build: () => new Request("https://api.test/notifications"),
  },
  {
    name: "401 notifications unread-count no session",
    route: "GET /notifications/unread-count",
    build: () => new Request("https://api.test/notifications/unread-count"),
  },
  // GET /notification-prefs authenticates via readCurrentSession, same shape as
  // GET /notifications above — its only error path (M2.3c). PUT
  // /notification-prefs is a mutating route and is already covered by the
  // automatic origin-less-rejection layer.
  {
    name: "401 notification-prefs no session",
    route: "GET /notification-prefs",
    build: () => new Request("https://api.test/notification-prefs"),
  },
  // GET /notifications/ws authenticates inline (origin, then session) rather
  // than via readCurrentSession-only, like the two above — see
  // src/routes/notifications-ws.ts (M2.3b). This probe carries an ALLOWED
  // Origin (so the origin-check layer passes first, pinning that the 401 comes
  // from readCurrentSession, not the WS-hijack guard) but no session cookie.
  {
    name: "401 notifications ws no session",
    route: "GET /notifications/ws",
    build: () =>
      new Request("https://api.test/notifications/ws", {
        headers: { Upgrade: "websocket", Origin: ALLOWED_ORIGIN },
      }),
  },
  // GET /posts/live authenticates inline (origin only — NO session), same
  // shape as GET /notifications/ws above except it never reads a session — see
  // src/routes/posts-live.ts (M2.3b-live). This probe carries a cross-site
  // Origin, so the 403 comes from the WS-hijack guard, not a session check
  // (there is none to run).
  {
    name: "403 posts/live rejected origin",
    route: "GET /posts/live",
    build: () =>
      new Request(`https://api.test/posts/live?postId=${PARAM_SAMPLES.id}`, {
        headers: { Upgrade: "websocket", Origin: "https://evil.example" },
      }),
  },
  // A malformed postId, with an ALLOWED Origin so the origin check passes
  // first and the 400 pins the validation step, not the hijack guard.
  {
    name: "400 posts/live bad postId",
    route: "GET /posts/live",
    build: () =>
      new Request("https://api.test/posts/live?postId=not-a-uuid", {
        headers: { Upgrade: "websocket", Origin: ALLOWED_ORIGIN },
      }),
  },
  // TEST_ROUTES is "1" in this suite (vitest.config.ts), so the gate is OPEN and
  // the route runs — with no token stashed in KV it takes its own not-found
  // path. That is the branch worth pinning here: it must be the SAME envelope as
  // any other 404, per src/http/errors.ts. (The gate-CLOSED 404 is covered by
  // test/email-verify.test.ts.)
  {
    name: "404 test route with no stashed token",
    route: "GET /__test/last-verify-token",
    build: () => new Request("https://api.test/__test/last-verify-token"),
  },
];

/**
 * Routes with NO reachable error path, each with the reason it has none AND a
 * pin of the handler source that reason was read from.
 *
 * ⚠️ AN ENTRY HERE IS A CLAIM, not a way to quiet `coverage`. It says: this
 * route cannot answer non-2xx, so there is no envelope to check. The moment it
 * grows a failure mode — a lookup, a validation, a binding that can be absent —
 * the entry is wrong and the route owes this file a `CASES` probe instead.
 *
 * ⚠️ WHY `handlerSource` EXISTS. "This route has no error path" is a claim about
 * code, and the claim is only true OF THE CODE IT WAS READ FROM. A route that
 * grows a query, a lookup or a validation makes its entry FALSE — and the
 * staleness/reason guards below would not notice, because the route still exists
 * and still states a reason. That is the "remembered, not checked" failure
 * surviving inside the fix for it. So the claim is keyed to its premise: when
 * the handler changes, the claim EXPIRES and someone must re-read it.
 *
 * This is not hypothetical — it has now happened once, to `GET /posts`. See the
 * note above `ERROR_FREE` for how that resolved, and for the shape of the WRONG
 * resolution (re-pinning the snapshot to whatever the code says today, which
 * converts the guard into a rubber stamp).
 */
interface ErrorFreeClaim {
  readonly reason: string;
  /**
   * `handler.toString()` with whitespace collapsed. Normalized because the pool
   * serves these through vite/esbuild, which strips TS annotations and reflows —
   * so the pin tracks what the handler DOES, not how it was formatted.
   */
  readonly handlerSource: string;
}

/**
 * ⚠️ `GET /posts` USED TO BE THE SECOND ENTRY HERE, AND ITS REMOVAL IS THE
 * MECHANISM WORKING — recorded because the next author deserves the worked
 * example this file's header describes in the abstract.
 *
 * Its claim: "the stub feed — a literal `{posts: []}` 200 ... when it grows a
 * real query it gains error paths and must move to CASES." Task 9 did not grow
 * it a query: it DELETED the route (M0's stub answered an empty array forever;
 * the real listing is `GET /public/profile`). So the claim was not falsified, it
 * was left with no subject — and `every ERROR_FREE entry still corresponds to a
 * real route` is the guard that fired, saying so.
 *
 * The resolution is therefore NOT a re-pinned `handlerSource` — there is no
 * handler left to pin, and re-pointing the entry at `GET /posts/:id` would have
 * been the "blindly update the snapshot" defeat in its purest form: a brand new
 * route with a session check, a DB read and two 404 paths, inheriting a claim
 * that it cannot answer non-2xx. The four successor routes are in CASES above,
 * each probed on a real failure.
 */
const ERROR_FREE: ReadonlyMap<string, ErrorFreeClaim> = new Map([
  [
    "GET /health",
    {
      reason:
        "A liveness probe with no input, no I/O and no branches: it returns a literal 200 'ok' (src/routes.ts) or the Worker is not running at all.",
      handlerSource: 'async () => new Response("ok", { status: 200 })',
    },
  ],
  // GET /health/db (db-health-probe) — a STATUS body, not an error envelope.
  // It answers 200 when the last recorded probe is ok and NOT stale, 503
  // otherwise ("stale"/"down"/"unknown") — but the 503 body is still
  // `{status, lastCheckAt, ageMs, staleAfterMs, checkedRecently}` (plus
  // gated detail under TEST_ROUTES), never a `{code}` envelope. It has no
  // params to validate and reads only KV (never the DB), so there is no
  // request-validation or lookup failure mode to probe either. See
  // src/routes/health-db.ts.
  [
    "GET /health/db",
    {
      reason:
        "Answers a health STATUS body (200 ok / 503 stale|down|unknown), never a {code} envelope — same shape as GET /health above, just with more states. No params to validate, and it reads only KV (never the DB), so it has no request-validation or lookup failure mode either. See src/routes/health-db.ts's handleHealthDb.",
      // ⚠️ The `__vite_ssr_import_0__` refs are the pool's vite-SSR transform
      // of health-db.ts's single import (readDbProbe + STALE_AFTER_MS, both
      // from src/health/probe.ts); deterministic for this code and, like
      // every pin here, breaks loudly if the handler is edited.
      handlerSource:
        'async function handleHealthDb(_request, env, _ctx, _params) { const state = await (0,__vite_ssr_import_0__.readDbProbe)(env); const now = Date.now(); const ageMs = state === null ? null : now - state.lastCheckAt; const isStale = ageMs !== null && ageMs > __vite_ssr_import_0__.STALE_AFTER_MS; const status = state === null ? "unknown" : isStale ? "stale" : state.ok ? "ok" : "down"; // A dumb external HTTP monitor (uptime checker, load balancer health check) // alerts on non-200 — so "ok" is the ONLY 2xx; every other status is 503. const httpStatus = status === "ok" ? 200 : 503; const body = { status, lastCheckAt: state?.lastCheckAt ?? null, ageMs, staleAfterMs: __vite_ssr_import_0__.STALE_AFTER_MS, checkedRecently: !isStale }; // Detail (the raw error string and the recent-probe series) is withheld // from the public/prod response — a leaked connection error (hostname, // driver internals) reads badly surfaced in an incident writeup, and the // recent series is more than an external monitor needs. Gated on the same // TEST_ROUTES flag every other dev/test-only seam uses (src/routes/__test.ts); // a future prod-auth gate can widen this deliberately. if (env.TEST_ROUTES === "1") { body.error = state?.error ?? null; body.latencyMs = state?.latencyMs ?? null; body.recent = state?.recent ?? []; }; return new Response(JSON.stringify(body), { status: httpStatus, headers: { "content-type": "application/json" } }); }',
    },
  ],
  // ⚠️ THE FIRST *MUTATING* ERROR_FREE ENTRY, and it is error-free BY SECURITY
  // DESIGN, not by lacking I/O. One-click unsubscribe (M2.3c, RFC 8058;
  // src/routes/unsub.ts) ALWAYS returns a neutral 200 (empty JSON) — for an
  // absent token, an invalid token, and a valid token alike — because revealing
  // which token was valid would leak whether an address is subscribed to anyone
  // who can guess a userId. It has no request-validation 400 (a bad token is a
  // silent 200), no lookup 404, and no auth 401/403 (the token IS the auth, and a
  // missing one is still a neutral 200). Its only branch is token-valid → DB
  // upsert → 200. It is therefore excluded from LAYER 1's automatic origin-less
  // probe (which asserts a >=400 envelope) via `MUTATING_WITH_ERROR_PATH` below —
  // an origin-less probe of THIS route is a 200, not a rejection to carry an
  // envelope. handlerSource pins that this remains true.
  [
    "POST /unsub",
    {
      reason:
        "Token-authed one-click unsubscribe (RFC 8058): it always answers a neutral 200 (empty JSON) — an absent/invalid token is a silent 200, a valid one upserts master_enabled=false and 200s, and a DB failure on that upsert (e.g. a valid never-expiring token for a since-deleted user → FK violation) is CAUGHT and swallowed, still 200. Revealing token validity would leak subscription state, so there is deliberately no 400/401/403/404/500 path to carry an envelope. See src/routes/unsub.ts.",
      // ⚠️ The `__vite_ssr_import_N__` refs are the pool's vite-SSR transform of
      // unsub.ts's two imports (withClient=0, verifyUnsubToken=1, in source
      // order); they are deterministic for this code and, like every pin here,
      // break loudly if the handler is edited so someone must re-read the claim.
      // The try/catch below is the "always 200 even on a DB error" guarantee the
      // reason describes — losing it is exactly the change this pin must catch.
      handlerSource:
        'async function handleUnsub(request, env, ctx) { const token = new URL(request.url).searchParams.get("token"); const ok = () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }); const userId = token === null ? null : await (0,__vite_ssr_import_1__.verifyUnsubToken)(env, token); if (userId === null) return ok(); try { await (0,__vite_ssr_import_0__.withClient)(env.HYPERDRIVE_FRESH, ctx, (c) => c.query(`INSERT INTO notification_prefs (user_id, master_enabled, updated_at) VALUES ($1, false, now()) ON CONFLICT (user_id) DO UPDATE SET master_enabled = false, updated_at = now()`, [userId])); } catch (err) { // Never logs the token. A valid token for a since-deleted user (FK // violation) or any transient DB failure must still answer neutrally. console.error("unsub write failed", err); }; return ok(); }',
    },
  ],
  // GET /public/tags (M2.4c) has no params to validate and no lookup that can
  // miss — it is a bounded GROUP BY listing with a single query and a single
  // 200 branch, same "no client-error path" shape as GET /health above. See
  // src/routes/public.ts's handlePublicTags.
  [
    "GET /public/tags",
    {
      reason: "no client-error path: no params — a fixed GROUP BY query with one 200 branch, no lookup that can miss and nothing to validate. See src/routes/public.ts's handlePublicTags.",
      // ⚠️ The `__vite_ssr_import_1__` ref is the pool's vite-SSR transform of
      // public.ts's `withClient` import; deterministic for this code and, like
      // every pin here, breaks loudly if the handler is edited.
      handlerSource:
        "async function handlePublicTags(_request, env, ctx) { const tags = await (0,__vite_ssr_import_1__.withClient)(env.HYPERDRIVE_FRESH, ctx, async (c) => { const { rows } = await c.query(`SELECT t.slug, t.label, count(*)::int AS count FROM tags t JOIN post_tags pt ON pt.tag_id = t.id JOIN posts p ON p.id = pt.post_id WHERE p.status = 'published' GROUP BY t.slug, t.label ORDER BY count DESC, t.slug ASC LIMIT ${TAGS_INDEX_MAX}`); return rows; }); return json({ tags }); }",
    },
  ],
]);

/**
 * The handler's source, normalized the same way `handlerSource` is.
 *
 * ⚠️ Relies on `Function.prototype.toString()` returning real source. That holds
 * here: the pool serves modules through vite (transformed, but never minified).
 * If a future build minifies the Worker under test, these pins will need to key
 * off something else — but they will FAIL LOUDLY when that happens, which is the
 * correct direction to break in.
 */
function handlerSourceOf(route: RouteDef): string {
  return route.handler.toString().replace(/\s+/g, " ").trim();
}

/**
 * Mutating routes MINUS those allowlisted as error-free. LAYER 1 probes an
 * origin-less request against each and asserts it carries a >=400 envelope — but
 * a route in ERROR_FREE has no such rejection to carry one (POST /unsub answers a
 * neutral 200 to every request by design; see its entry). Excluding it here is
 * the SAME decision ERROR_FREE already records, applied to the automatic layer;
 * `coverage` below then re-includes it through ERROR_FREE so nothing goes
 * un-ledgered.
 */
const MUTATING_WITH_ERROR_PATH = MUTATING.filter((r) => !ERROR_FREE.has(label(r)));

/**
 * LAYER 1 — automatic. No per-route knowledge, so it cannot fall behind ROUTES.
 */
describe("every mutating route's rejection carries the {code, message?} envelope", () => {
  it("there is at least one mutating route to check", () => {
    expect(MUTATING_WITH_ERROR_PATH.length).toBeGreaterThan(0);
  });

  it.each(MUTATING_WITH_ERROR_PATH.map((r) => [label(r), r] as const))(
    "%s — origin-less rejection",
    async (_name, route) => {
      const response = await fetchWorker(
        new Request(`https://api.test${concretePath(route.pattern)}`, {
          method: route.method,
          headers: { "content-type": "application/json" },
          body: probeBody(),
        }),
      );

      await expectEnvelope(response);
    },
  );
});

/** LAYER 2 — the bespoke probes. */
describe("every ledgered error path carries the {code, message?} envelope", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, errorCase) => {
    await expectEnvelope(await fetchWorker(errorCase.build()));
  });
});

/**
 * THE LEDGER — what makes the two layers above an INVENTORY rather than a list.
 */
describe("error-envelope coverage", () => {
  const registered = new Set(ROUTES.map(label));
  // ⚠️ `MUTATING_WITH_ERROR_PATH`, not `MUTATING` — a route allowlisted as
  // ERROR_FREE is NOT probed by LAYER 1, so counting it as "exercised" here would
  // be a lie. It is instead covered by the `!ERROR_FREE.has(r)` clause below.
  const exercised = new Set<string>([
    ...MUTATING_WITH_ERROR_PATH.map(label),
    ...CASES.map((c) => c.route).filter((r): r is string => r !== null),
  ]);

  it("every registered route is exercised or explicitly allowlisted", () => {
    const uncovered = [...registered].filter(
      (r) => !exercised.has(r) && !ERROR_FREE.has(r),
    );

    expect(
      uncovered,
      `these routes are registered in src/routes.ts but no error path of theirs is checked here: ${uncovered.join(", ")}. Add a probe to CASES, or — only if the route genuinely cannot answer non-2xx — add it to ERROR_FREE with the reason why. Do not leave it out: a route nobody probed is a route free to invent a fifth error dialect.`,
    ).toEqual([]);
  });

  it("every ERROR_FREE entry still corresponds to a real route", () => {
    // A stale claim is a trap: it would silently excuse a FUTURE route that
    // happens to reuse the same method+pattern.
    for (const [route, { reason }] of ERROR_FREE) {
      expect(
        registered,
        `ERROR_FREE claims "${route}" has no error path, but the router no longer has that route. Remove the entry. (Its stated reason was: ${reason})`,
      ).toContain(route);
    }
  });

  it("every ERROR_FREE entry states a reason", () => {
    for (const [route, { reason }] of ERROR_FREE) {
      expect(
        reason.length,
        `ERROR_FREE["${route}"] must say WHY the route has no error path — that justification is the whole value of the allowlist.`,
      ).toBeGreaterThan(20);
    }
  });

  /**
   * ⚠️ THE CLAIM EXPIRES WITH ITS PREMISE. The two guards above check that the
   * claim is well-FORMED (real route, stated reason). Neither checks that it is
   * still TRUE. This one does the only thing that can be checked mechanically:
   * it detects when the code the reason was read from has changed underneath it.
   */
  it("every ERROR_FREE entry's handler is unchanged since the claim was made", () => {
    for (const [routeLabel, { reason, handlerSource }] of ERROR_FREE) {
      const route = ROUTES.find((r) => label(r) === routeLabel);
      // The staleness guard above owns the "route is gone" message; skip rather
      // than throw here so this test reports only what it is about.
      if (route === undefined) continue;

      expect(
        handlerSourceOf(route),
        `ERROR_FREE claims "${routeLabel}" has no error path because: ${reason}\n\nIts handler has CHANGED since that claim was made — re-read it. If it now has a failure mode (a query, a lookup, a validation, a binding that can be absent), move the route to CASES and probe that failure. If it is still genuinely error-free, update this pin deliberately.`,
      ).toBe(handlerSource);
    }
  });

  it("every CASE names a route that actually exists", () => {
    for (const errorCase of CASES) {
      if (errorCase.route === null) continue;
      expect(
        registered,
        `CASES["${errorCase.name}"] probes "${errorCase.route}", which is not in src/routes.ts. Either the route was removed (delete the case) or it is reachable without being registered (fix the router — src/index.ts must dispatch only through ROUTES).`,
      ).toContain(errorCase.route);
    }
  });
});

/**
 * `suggestions` — the optional envelope extension a future USERNAME_TAKEN
 * response uses to offer a few available handles (Task 2+). Unit-level,
 * against `errorResponse` directly rather than through a route: no route
 * emits `suggestions` yet, so this is what pins the wire shape ahead of that.
 */
it("errorResponse carries optional suggestions", async () => {
  const res = errorResponse("USERNAME_TAKEN", 409, { fields: ["username"], suggestions: ["ada2", "ada3"] });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body).toMatchObject({ code: "USERNAME_TAKEN", fields: ["username"], suggestions: ["ada2", "ada3"] });
});
