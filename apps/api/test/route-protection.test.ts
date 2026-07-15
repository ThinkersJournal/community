import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
// The ROUTER'S OWN SOURCE, as text. See `discoverRoutes` — this is what makes
// the suite an INVENTORY rather than a list someone has to remember to update.
import indexSource from "../src/index.ts?raw";

/**
 * THE ROUTE-PROTECTION INVENTORY — a DEFAULT-DENY BACKSTOP for every mutating
 * route the router dispatches.
 *
 * ⚠️ WHY THIS FILE EXISTS. `runMutatingPipeline` (src/auth/pipeline.ts) is the
 * security spine of every non-GET route — but the router (src/index.ts) only
 * DISPATCHES; each HANDLER calls the pipeline itself. That is a defensible
 * design (a route owns its own opt-ins: `requireVerifiedEmail`, `rateLimit`),
 * and it is what was built. Its cost is that "every mutating route is
 * protected" is a CONVENTION rather than a guarantee — something every future
 * author has to remember.
 *
 * The failure that motivates this suite is quiet and total: an M1 task adds
 * `POST /comments`, forgets `runMutatingPipeline`, and ships an unauthenticated
 * mutation endpoint. Typecheck passes. Every existing test passes — they all
 * test the routes that DO call the pipeline. Nothing anywhere goes red.
 *
 * So this file does not assert anything about a fixed list of routes. It reads
 * the router's source, ENUMERATES the (method, path) pairs it actually matches,
 * and holds every non-GET one to the two properties the pipeline guarantees:
 *
 *   • no `Origin`  -> 403   (the pipeline's step 1 — before ANY I/O)
 *   • no session   -> 401   (its step 2)
 *
 * A NEW mutating route is therefore covered the moment it is added to the
 * router, whether or not anyone thought about this file. If it runs the
 * pipeline, it passes. If it does not, it fails here — and the only way to make
 * it pass without the pipeline is to add it to `PIPELINE_EXEMPT` below, which is
 * a deliberate, reviewable act with a documented justification, not an omission.
 *
 * Runs in the POOL project (real workerd): the router is driven end to end,
 * against real KV/DO/Postgres bindings, exactly as production would.
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
const PIPELINE_EXEMPT: ReadonlySet<string> = new Set([
  "POST /auth/signup",
  "POST /auth/login",
]);

/**
 * The router's dispatch shape, as written in src/index.ts:
 *
 *     if (request.method === "POST" && pathname === "/auth/signup") {
 *
 * ⚠️ This regex is coupled to that literal style ON PURPOSE — a source-text
 * inventory is only as good as its ability to see every route. `SANITY_ROUTES`
 * below is the tripwire: if the router is ever rewritten in a shape this pattern
 * cannot read (a table, a `switch`, a helper), the match count collapses and
 * that assertion fails LOUDLY, demanding this file be taught the new shape —
 * rather than silently discovering zero routes and passing vacuously, which is
 * the one failure mode that would make this whole suite decorative.
 */
const ROUTE_PATTERN = /request\.method === "([A-Z]+)"\s*&&\s*pathname === "([^"]+)"/g;

interface Route {
  method: string;
  path: string;
}

/** Every (method, path) pair the router matches, read out of its source. */
function discoverRoutes(): Route[] {
  return [...indexSource.matchAll(ROUTE_PATTERN)].map(([, method, path]) => ({
    method: method!,
    path: path!,
  }));
}

const DISCOVERED = discoverRoutes();

/** `"POST /posts"` — the key used by `PIPELINE_EXEMPT` and the test names. */
function label(route: Route): string {
  return `${route.method} ${route.path}`;
}

/**
 * GET routes that must be discoverable if `ROUTE_PATTERN` is still reading the
 * router correctly. Deliberately the READ routes: they are stable, they are not
 * what this file asserts about, and requiring them proves the parse works
 * without coupling the tripwire to the mutating routes under test.
 */
const SANITY_ROUTES = ["/health", "/auth/csrf", "/verify-email", "/posts"];

/** The non-GET routes — what this suite is about. */
const MUTATING = DISCOVERED.filter(
  (r) => r.method !== "GET" && r.method !== "HEAD",
);

/**
 * A body that satisfies BOTH `SignupInput` and `LoginInput` (zod strips the
 * extra key for login), and that every other route ignores. One body for every
 * route keeps this generic: signup and login validate BEFORE their origin check
 * (rejecting garbage before spending anything), so a request meant to prove
 * "no Origin -> 403" must get past zod first or it 400s and proves nothing.
 */
function probeBody(): string {
  return JSON.stringify({
    email: `route-protection-${crypto.randomUUID()}@example.com`,
    password: "correct-horse-battery-staple",
    turnstileToken: "dummy-turnstile-token",
  });
}

/** An origin in `checkOrigin`'s allowlist (dev — the suite runs TEST_ROUTES=1). */
const ALLOWED_ORIGIN = "http://localhost:8787";

function probe(route: Route, headers: Record<string, string>): Request {
  return new Request(`https://api.test${route.path}`, {
    method: route.method,
    headers: { "content-type": "application/json", ...headers },
    body: probeBody(),
  });
}

/** Drive the Worker through a full request lifecycle. */
async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("route inventory", () => {
  it("can still read the router's route table (tripwire for ROUTE_PATTERN)", () => {
    const getPaths = DISCOVERED.filter((r) => r.method === "GET").map((r) => r.path);

    expect(
      getPaths,
      "ROUTE_PATTERN found none of the router's known GET routes — src/index.ts has probably been rewritten in a dispatch shape this file cannot parse. FIX THE PATTERN, do not delete this test: every assertion in this file iterates over what the pattern discovers, so a pattern that matches nothing makes the whole route-protection suite pass vacuously.",
    ).toEqual(expect.arrayContaining(SANITY_ROUTES));
  });

  it("found at least one mutating route to check", () => {
    expect(
      MUTATING.length,
      "no non-GET routes were discovered in src/index.ts — see the tripwire above",
    ).toBeGreaterThan(0);
  });

  it("every exemption in PIPELINE_EXEMPT still corresponds to a real route", () => {
    // A stale exemption is a trap: it would silently excuse a FUTURE route that
    // happens to reuse the path from the checks below.
    const discovered = new Set(MUTATING.map(label));
    for (const exempt of PIPELINE_EXEMPT) {
      expect(
        discovered,
        `PIPELINE_EXEMPT lists "${exempt}", which the router no longer has. Remove the exemption.`,
      ).toContain(exempt);
    }
  });
});

/**
 * THE DEFAULT-DENY ASSERTIONS. Every discovered mutating route that is not
 * explicitly exempt must be running the pipeline, proven by its two cheapest
 * observable guarantees.
 */
describe("every mutating route runs the mutating pipeline", () => {
  const pipelineRoutes = MUTATING.filter((r) => !PIPELINE_EXEMPT.has(label(r)));

  it("there is at least one non-exempt mutating route (the exemptions have not swallowed the suite)", () => {
    expect(pipelineRoutes.length).toBeGreaterThan(0);
  });

  it.each(pipelineRoutes.map((r) => [label(r), r] as const))(
    "%s — no Origin -> 403 (pipeline step 1, before any I/O)",
    async (name, route) => {
      // A cookie that resolves to no session: were the session lookup running
      // first this would be a 401, so 403 also pins the ORDER.
      const response = await fetchWorker(
        probe(route, { Cookie: "tj_session=not-a-real-token" }),
      );

      expect(
        response.status,
        `${name} did not reject an origin-less mutation with a 403. If this route is new: call runMutatingPipeline (src/auth/pipeline.ts) in its handler — the router does NOT apply it for you. If it genuinely cannot (it has no session to require, like signup/login), add "${name}" to PIPELINE_EXEMPT in this file and give it an inline checkOrigin. Do NOT leave a mutating route with neither.`,
      ).toBe(403);
    },
  );

  it.each(pipelineRoutes.map((r) => [label(r), r] as const))(
    "%s — no session -> 401 (pipeline step 2, with an allowed Origin so step 1 passes)",
    async (name, route) => {
      const response = await fetchWorker(probe(route, { Origin: ALLOWED_ORIGIN }));

      // 401 is what the pipeline returns; 403 is accepted because a route could
      // legitimately reject an anonymous mutation at an even earlier check.
      // What is NOT acceptable is a 2xx — an unauthenticated mutation.
      expect(
        [401, 403],
        `${name} let an UNAUTHENTICATED mutation through with ${response.status}. If this route is new: call runMutatingPipeline (src/auth/pipeline.ts) in its handler — the router does NOT apply it for you.`,
      ).toContain(response.status);
    },
  );
});

/**
 * THE EXEMPT ROUTES — exempt from the PIPELINE, never from the origin check.
 *
 * `checkOrigin` is the only pipeline step that applies before a session exists,
 * and on these two routes it is the ENTIRE CSRF defense: they have no session,
 * hence no `csrfSecret`, hence no double-submit token to fall back on (see the
 * header of src/routes/login.ts). So an exemption still owes this assertion.
 */
describe("pipeline-exempt routes enforce checkOrigin inline", () => {
  const exemptRoutes = MUTATING.filter((r) => PIPELINE_EXEMPT.has(label(r)));

  it.each(exemptRoutes.map((r) => [label(r), r] as const))(
    "%s — no Origin -> 403",
    async (name, route) => {
      const response = await fetchWorker(probe(route, {}));

      expect(
        response.status,
        `${name} is in PIPELINE_EXEMPT but did not 403 an origin-less request. An exempt route MUST still call checkOrigin inline — it has no session, so there is no CSRF token to catch this instead.`,
      ).toBe(403);
    },
  );

  it.each(exemptRoutes.map((r) => [label(r), r] as const))(
    "%s — a disallowed Origin -> 403",
    async (name, route) => {
      const response = await fetchWorker(
        probe(route, { Origin: "https://evil.example" }),
      );

      expect(
        response.status,
        `${name} accepted a cross-site Origin — checkOrigin is its whole CSRF defense.`,
      ).toBe(403);
    },
  );
});
