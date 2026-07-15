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
 * Routes with NO reachable error path, each with the reason it has none.
 *
 * ⚠️ AN ENTRY HERE IS A CLAIM, not a way to quiet `coverage`. It says: this
 * route cannot answer non-2xx, so there is no envelope to check. The moment it
 * grows a failure mode — a lookup, a validation, a binding that can be absent —
 * the entry is wrong and the route owes this file a `CASES` probe instead.
 */
const ERROR_FREE: ReadonlyMap<string, string> = new Map([
  [
    "GET /health",
    "A liveness probe with no input, no I/O and no branches: it returns a literal 200 'ok' (src/routes.ts) or the Worker is not running at all.",
  ],
  [
    "GET /posts",
    "The stub feed — a literal `{posts: []}` 200, deliberately un-gated (reads stay open, so there is nothing to reject). When it grows a real query it gains error paths and must move to CASES.",
  ],
]);

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
    for (const [route, reason] of ERROR_FREE) {
      expect(
        registered,
        `ERROR_FREE claims "${route}" has no error path, but the router no longer has that route. Remove the entry. (Its stated reason was: ${reason})`,
      ).toContain(route);
    }
  });

  it("every ERROR_FREE entry states a reason", () => {
    for (const [route, reason] of ERROR_FREE) {
      expect(
        reason.length,
        `ERROR_FREE["${route}"] must say WHY the route has no error path — that justification is the whole value of the allowlist.`,
      ).toBeGreaterThan(20);
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
