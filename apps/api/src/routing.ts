/**
 * The api Worker's dispatch primitives. Deliberately ~40 lines and dependency-
 * free: a router is not where this project spends its complexity budget.
 *
 * ⚠️ WHY A TABLE AND NOT AN IF-CHAIN. M0's router was a chain of
 * `pathname === "/literal"` checks, and test/route-protection.test.ts — the
 * compensating control for "the router dispatches, each HANDLER runs the
 * pipeline" — enumerated routes by REGEXING that source text. M1 introduces
 * dynamic paths (`PATCH /posts/:id`), which such a regex cannot see, and the
 * file's tripwire would NOT fire (it only requires the static sanity routes to
 * still be found). A new mutating route would have gone silently un-inventoried
 * — the exact failure that file exists to catch, arriving through its blind
 * spot. Exporting a table the test IMPORTS makes the inventory structural: it
 * cannot be defeated by formatting, by a dynamic segment, or by a rewrite.
 *
 * ⚠️ THIS CHANGES THE ROUTER'S SHAPE, NOT ITS RULE. The table still only
 * DISPATCHES. Each handler calls `runMutatingPipeline` itself, because that is
 * what lets a route own its own opt-ins (`requireVerifiedEmail` for
 * POST /posts, deliberately not for logout) — a blanket wrap could not express
 * that. See src/auth/pipeline.ts and the M0 plan's deviation H3.
 */
export type RouteParams = Readonly<Record<string, string>>;

export type RouteHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
) => Promise<Response>;

export interface RouteDef {
  readonly method: string;
  /** A path pattern. `:name` segments capture one path segment each. */
  readonly pattern: string;
  readonly handler: RouteHandler;
}

/**
 * Match `pathname` against `pattern`, returning the captured params (`{}` when
 * there are none) or `null` for no match.
 *
 * Segment-count-exact and slash-exact: a `:param` NEVER spans a `/`. An empty
 * capture is a non-match rather than `""` — an empty id reaching a handler as a
 * real value produces a nonsense query rather than a 404. An undecodable
 * segment is likewise a non-match, never a throw: a malformed URL is a 404, not
 * a 500.
 */
export function matchPattern(pattern: string, pathname: string): RouteParams | null {
  const expected = pattern.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i++) {
    const segment = expected[i]!;
    const value = actual[i]!;

    if (!segment.startsWith(":")) {
      if (segment !== value) return null;
      continue;
    }

    if (value === "") return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return null;
    }
    if (decoded === "") return null;
    params[segment.slice(1)] = decoded;
  }
  return params;
}

/** The first route matching `method` + `pathname`, with its params, or null. */
export function findRoute(
  routes: readonly RouteDef[],
  method: string,
  pathname: string,
): { route: RouteDef; params: RouteParams } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPattern(route.pattern, pathname);
    if (params !== null) return { route, params };
  }
  return null;
}
