import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
// The ROUTER'S OWN SOURCE, as text — used for ONE assertion only (the tripwire
// below), not to enumerate routes. The inventory itself is structural: it
// IMPORTS the table.
import indexSource from "../src/index.ts?raw";
import { ROUTES } from "../src/routes";
import { findRoute } from "../src/routing";

import type { RouteDef } from "../src/routing";

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
 * So this file does not assert anything about a fixed list of routes. It
 * IMPORTS the router's route table (src/routes.ts), enumerates the
 * (method, pattern) pairs it actually dispatches, and holds every non-GET one to
 * the two properties the pipeline guarantees:
 *
 *   • no `Origin`  -> 403   (the pipeline's step 1 — before ANY I/O)
 *   • no session   -> 401   (its step 2)
 *
 * ⚠️ THIS DISCOVERY USED TO BE A REGEX over src/index.ts's `pathname ===
 * "/literal"` if-chain, and that had a BLIND SPOT that mattered: a
 * parameterized route (`PATCH /posts/:id`) is not a string literal, so the
 * pattern could not see it — and the old tripwire would not have fired either,
 * because it only required the STATIC sanity routes to still be found. A new
 * mutating route would have shipped silently un-inventoried through the blind
 * spot of the very file written to prevent that. Importing the table closes it:
 * the inventory cannot be defeated by formatting, by a dynamic segment, or by a
 * future rewrite. Do not regress this to source-text matching.
 *
 * A NEW mutating route is therefore covered the moment it is added to the
 * table, whether or not anyone thought about this file. If it runs the
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

/** `"POST /posts"` — the key used by `PIPELINE_EXEMPT` and the test names. */
function label(route: RouteDef): string {
  return `${route.method} ${route.pattern}`;
}

/** The non-GET routes — what this suite is about. */
const MUTATING = ROUTES.filter((r) => r.method !== "GET" && r.method !== "HEAD");

/**
 * Concrete sample values for `:param` segments, so a pattern can be probed as a
 * real URL. The values need only be well-formed — every assertion below rejects
 * the request long before a handler could look one up.
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

function probe(route: RouteDef, headers: Record<string, string>): Request {
  return new Request(`https://api.test${concretePath(route.pattern)}`, {
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

/**
 * src/index.ts with block comments stripped and all whitespace collapsed — the
 * form `the dispatcher is pinned` compares. Normalizing means reformatting or
 * re-commenting the file does not fail the pin; changing what it DOES will.
 */
const DISPATCHER_BODY = indexSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\s+/g, " ")
  .trim();

/**
 * ⚠️ THE PINNED DISPATCHER — the exact normalized body of src/index.ts.
 *
 * This is a SNAPSHOT, deliberately hand-maintained. Do not "fix" a failure by
 * pasting in the new value without reading the diff: the assertion exists to
 * make you look.
 */
const EXPECTED_DISPATCHER_BODY =
  'import { notFoundResponse } from "./http/errors"; ' +
  'import { ROUTES } from "./routes"; ' +
  'import { findRoute } from "./routing"; ' +
  'export { UserSecurityDO } from "./durable-objects/UserSecurityDO"; ' +
  'export { NotifyDO } from "./durable-objects/NotifyDO"; ' +
  "export default { async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { " +
  "const { pathname } = new URL(request.url); " +
  "const match = findRoute(ROUTES, request.method, pathname); " +
  "if (match === null) return notFoundResponse(); " +
  "return await match.route.handler(request, env, ctx, match.params); " +
  "}, } satisfies ExportedHandler<Env>;";

describe("route inventory", () => {
  it("index.ts dispatches ONLY through ROUTES — its whole body is pinned", () => {
    // ⚠️ THE TRIPWIRE. Every assertion in this file enumerates ROUTES, so a
    // route reachable any OTHER way is invisible here and this suite passes
    // vacuously about it. That is the one property that cannot be checked
    // structurally, so it is checked textually.
    //
    // ⚠️ WHY THE WHOLE BODY, AND NOT `toContain("findRoute(ROUTES,")` PLUS A
    // BAN ON SOME IDIOM. Presence is not exclusivity. This passes both of
    // those checks and serves /admin to the world, un-inventoried:
    //
    //     if (pathname.startsWith("/admin")) return handleAdmin(req, env, ctx, {});
    //     const match = findRoute(ROUTES, request.method, pathname);
    //
    // So would `switch (pathname)`, `pathname.match(...)`, Yoda
    // (`"/admin" === pathname`), aliasing (`const p = pathname`), or a second
    // `findRoute(EXTRA, ...)`. A blocklist can only ban the idioms someone
    // imagined; this file's own history proves that is not good enough —
    // `startsWith` is the idiom M0's router ACTUALLY used for /__test/, and the
    // one a dynamic route reaches for first. An allowlist of exactly one body
    // inverts the burden: every unimagined idiom fails by default.
    //
    // This file is 20 lines and should essentially never change, so the cost of
    // pinning it is ~zero and any edit becomes a deliberate, reviewed act.
    expect(
      DISPATCHER_BODY,
      "src/index.ts changed. It is pinned because every assertion in this file enumerates ROUTES: a route reachable any other way is NOT covered by the default-deny checks below. If this change adds dispatch, move the route to src/routes.ts. If it is genuinely benign, update this snapshot deliberately.",
    ).toBe(EXPECTED_DISPATCHER_BODY);
  });

  it("found at least one mutating route to check", () => {
    expect(
      MUTATING.length,
      "no non-GET routes were found in src/routes.ts — see the tripwire above",
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

  /**
   * ⚠️ A ROW IN ROUTES MUST MEAN WHAT IT SAYS. `findRoute` is first-match-wins,
   * so an earlier pattern can SHADOW a later one (register `/posts/:id` before
   * `/posts/new` and the literal is dead code). That is not a default-deny
   * bypass — dispatch and the probes below both resolve through `findRoute`, so
   * the shadowed path is still protected by whatever answers it. It is worse in
   * a different way: the table is a SECURITY INVENTORY, and a shadowed row makes
   * it attest to a handler that never runs, while every assertion "about" that
   * row is really exercising the other route's handler. Green, and lying.
   */
  it.each(ROUTES.map((r) => [label(r), r] as const))(
    "%s is reachable at its own path (not shadowed by an earlier pattern)",
    (name, route) => {
      expect(
        findRoute(ROUTES, route.method, concretePath(route.pattern))?.route,
        `${name} is shadowed by an earlier entry in ROUTES — it can never be served, and every assertion about it is actually testing the other route's handler. Register the more specific pattern first.`,
      ).toBe(route);
    },
  );
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
