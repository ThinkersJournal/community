import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { handlePurgeRequest } from "../src/lib/purge";

import type { PurgeContext } from "../src/lib/purge";

/**
 * The web half of the purge hop — the ONLY place cached renders are invalidated,
 * and a route that is PUBLICLY REACHABLE with a shared secret as its only guard.
 * So the cases that matter most here are the refusals.
 *
 * ⚠️ NOTHING HERE OBSERVES A PURGE. Workers Cache is not simulated by miniflare,
 * and this suite is plain Node besides — `context.cache.invalidate` is a spy. That
 * a purge REACHES the edge is deploy-gate-only. What this pins is the decision:
 * who is allowed to ask, and with which tags.
 *
 * ⚠️ THE REFUSAL CASES WOULD PASS VACUOUSLY against a handler that never invalidates
 * at all. What earns them is `authorizes the correct secret` below: same harness,
 * same spy, asserting the POSITIVE first — so the spy is proven able to see a call
 * before any test claims it did not happen.
 */
const SECRET = "dev-purge-secret-not-for-production";

/**
 * ⚠️ THE ROUTE MUST BE REACHABLE, WHICH NOTHING ELSE HERE CHECKS. Every other case
 * in this file calls `handlePurgeRequest` directly and never routes — so all of
 * them passed while the route 404'd against a real Worker.
 *
 * The plan put this route at `src/pages/__internal/purge.ts`. Astro's router SKIPS
 * any file OR DIRECTORY whose name starts with `_` (astro@7.0.9,
 * dist/core/routing/create-manifest.js: `if (name[0] === "_") { continue; }`), so
 * the route never entered the build manifest — no warning, no error, just a 404 at
 * runtime for the one request that keeps the site from serving 25h-stale HTML.
 *
 * This pins the FILE LOCATION, not the handler, because the file location is what
 * was wrong. `apps/api/src/cache/purge.ts`'s PURGE_PATH must name the same route;
 * that side is pinned by apps/api/test/purge.test.ts.
 */
const PAGES_DIR = join(import.meta.dirname, "../src/pages");
const ROUTE_FILE = join(PAGES_DIR, "internal/purge.ts");

describe("⚠️ the purge route is ROUTABLE (not just correct)", () => {
  it("lives where api dispatches: src/pages/internal/purge.ts -> POST /internal/purge", () => {
    expect(existsSync(ROUTE_FILE), `${ROUTE_FILE} does not exist`).toBe(true);
  });

  it("has NO underscore-prefixed path segment, which Astro would silently drop", () => {
    const segments = ["internal", "purge.ts"];
    for (const segment of segments) {
      expect(
        segment.startsWith("_"),
        `"${segment}" starts with "_", so Astro's router skips it and the route 404s with no warning anywhere. See this file's header.`,
      ).toBe(false);
    }
  });
});

function context(
  headers: Record<string, string>,
  body: string,
): PurgeContext & { cache: { invalidate: ReturnType<typeof vi.fn> } } {
  return {
    request: new Request("https://thinkersjournal.com/internal/purge", {
      method: "POST",
      headers,
      body,
    }),
    cache: { invalidate: vi.fn(async () => {}) },
  };
}

const withSecret = (secret: string, tags: unknown = ["post:1", "listing"]) =>
  context({ "X-Purge-Secret": secret, "content-type": "application/json" }, JSON.stringify({ tags }));

describe("handlePurgeRequest — authorization", () => {
  it("authorizes the correct secret and invalidates the tags", async () => {
    // ⚠️ THE ANTI-VACUITY ANCHOR for every `not.toHaveBeenCalled()` below.
    const ctx = withSecret(SECRET);
    const response = await handlePurgeRequest(ctx, SECRET);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ purged: 2 });
    // ⚠️ INSIDE THIS WORKER'S ENTRYPOINT — the only scope where this reaches the
    // cache holding our rendered HTML. One call, every tag.
    expect(ctx.cache.invalidate).toHaveBeenCalledTimes(1);
    expect(ctx.cache.invalidate).toHaveBeenCalledWith({ tags: ["post:1", "listing"] });
  });

  it("REJECTS a wrong secret, and purges nothing", async () => {
    const ctx = withSecret("wrong-secret-of-the-same-length-000000");
    const response = await handlePurgeRequest(ctx, SECRET);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "FORBIDDEN" });
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("REJECTS a secret that is merely a PREFIX of the real one", async () => {
    // The length check in timingSafeEqual is what catches this; it must not be
    // mistaken for a match on the characters that do line up.
    const ctx = withSecret(SECRET.slice(0, 10));
    expect((await handlePurgeRequest(ctx, SECRET)).status).toBe(403);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("REJECTS a MISSING secret header", async () => {
    const ctx = context({ "content-type": "application/json" }, JSON.stringify({ tags: ["x"] }));
    expect((await handlePurgeRequest(ctx, SECRET)).status).toBe(403);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("⚠️ FAILS CLOSED when the binding's secret is UNDEFINED", async () => {
    // An unset PURGE_SECRET must never make every caller authorized. This is the
    // shape of a real deploy mistake: `wrangler secret put` run on api but not web.
    const ctx = withSecret(SECRET);
    expect((await handlePurgeRequest(ctx, undefined)).status).toBe(403);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("⚠️ FAILS CLOSED when the binding's secret is EMPTY, even for an empty header", async () => {
    // Without the explicit `=== ""` guard, `timingSafeEqual("", "")` is TRUE and
    // an empty secret authorizes the entire internet.
    const ctx = withSecret("");
    expect((await handlePurgeRequest(ctx, "")).status).toBe(403);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });
});

describe("handlePurgeRequest — input", () => {
  it("400s on a malformed JSON body, and purges nothing", async () => {
    const ctx = context({ "X-Purge-Secret": SECRET }, "not json{");
    const response = await handlePurgeRequest(ctx, SECRET);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_JSON" });
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("400s on an empty tag list rather than purging nothing expensively", async () => {
    const ctx = withSecret(SECRET, []);
    const response = await handlePurgeRequest(ctx, SECRET);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_INPUT", fields: ["tags"] });
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("400s when `tags` is ABSENT", async () => {
    // Built by hand, NOT via `withSecret(SECRET, undefined)` — that argument hits
    // the helper's DEFAULT and would silently send the real tags, making this
    // assert 200 === 400. The omitted key has to actually be omitted.
    const ctx = context({ "X-Purge-Secret": SECRET }, JSON.stringify({}));
    expect((await handlePurgeRequest(ctx, SECRET)).status).toBe(400);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("400s when `tags` is not an array", async () => {
    const ctx = withSecret(SECRET, "listing");
    expect((await handlePurgeRequest(ctx, SECRET)).status).toBe(400);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("400s on a JSON body that is not an object at all", async () => {
    // `null.tags` would throw a TypeError and 500 the route; `"[]".tags` is
    // undefined. Both must land on the same 400.
    for (const body of ["null", "[]", '"a string"', "42"]) {
      const ctx = context({ "X-Purge-Secret": SECRET }, body);
      expect((await handlePurgeRequest(ctx, SECRET)).status).toBe(400);
    }
  });

  it("drops non-string and empty tags rather than forwarding junk to the purge API", async () => {
    const ctx = withSecret(SECRET, ["post:1", 42, "", null, "listing"]);
    const response = await handlePurgeRequest(ctx, SECRET);
    expect(response.status).toBe(200);
    expect(ctx.cache.invalidate).toHaveBeenCalledWith({ tags: ["post:1", "listing"] });
  });

  it("400s when EVERY tag was junk (nothing survived the filter)", async () => {
    const ctx = withSecret(SECRET, [42, "", null]);
    expect((await handlePurgeRequest(ctx, SECRET)).status).toBe(400);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });
});
