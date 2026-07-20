import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
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
  // GET /follows/status authenticates via readCurrentSession, same as GET
  // /profile/me above — its only error path (M2.1).
  {
    name: "401 follows/status with no session",
    route: "GET /follows/status",
    build: () => new Request("https://api.test/follows/status?id=00000000-0000-7000-8000-000000000000"),
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
 * LAYER 1 — automatic. No per-route knowledge, so it cannot fall behind ROUTES.
 */
describe("every mutating route's rejection carries the {code, message?} envelope", () => {
  it("there is at least one mutating route to check", () => {
    expect(MUTATING.length).toBeGreaterThan(0);
  });

  it.each(MUTATING.map((r) => [label(r), r] as const))(
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
  const exercised = new Set<string>([
    ...MUTATING.map(label),
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
