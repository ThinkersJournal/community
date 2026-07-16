import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import cacheProviderFactory from "@astrojs/cloudflare/cache/provider";
import { PIPELINE_VERSION } from "@thinkersjournal/markdown";
import { SESSION_COOKIE_NAME } from "@thinkersjournal/shared";
import { describe, expect, it, vi } from "vitest";

import {
  FEED_MAX_AGE,
  FEED_SWR,
  hasViewerState,
  markFeedCacheable,
  markPrivate,
  markPublicCacheable,
  PUBLIC_MAX_AGE,
  PUBLIC_SWR,
} from "../src/lib/cache";

import type { CacheContext } from "../src/lib/cache";

function context(cookie?: string): CacheContext & { cache: { set: ReturnType<typeof vi.fn> } } {
  return {
    request: new Request("https://thinkersjournal.com/@a/b", {
      headers: cookie === undefined ? {} : { Cookie: cookie },
    }),
    response: { headers: new Headers() },
    cache: { set: vi.fn() },
  } as never;
}

describe("hasViewerState", () => {
  it("is true when the session cookie is present", () => {
    expect(hasViewerState(context(`${SESSION_COOKIE_NAME}=abc`))).toBe(true);
  });

  it("finds the cookie among others, in any position", () => {
    expect(hasViewerState(context(`other=1; ${SESSION_COOKIE_NAME}=abc; more=2`))).toBe(true);
  });

  it("is false for no cookie header at all", () => {
    expect(hasViewerState(context())).toBe(false);
  });

  it("is false for unrelated cookies", () => {
    expect(hasViewerState(context("theme=dark; cf_clearance=x"))).toBe(false);
  });

  it("does NOT false-positive on a cookie whose name merely CONTAINS ours", () => {
    // `not_tj_session=x` must not read as a session, or every visitor with such
    // a cookie silently loses caching.
    expect(hasViewerState(context("not_tj_session=x"))).toBe(false);
  });
});

describe("markPublicCacheable", () => {
  it("marks an ANONYMOUS render cacheable with the right TTLs and tags", () => {
    const ctx = context();
    expect(markPublicCacheable(ctx, ["post:1", "author:2", "listing"])).toBe(true);
    expect(ctx.cache.set).toHaveBeenCalledWith({
      maxAge: PUBLIC_MAX_AGE,
      swr: PUBLIC_SWR,
      tags: ["post:1", "author:2", "listing", `pipeline:${PIPELINE_VERSION}`],
    });
  });

  it("always appends the `pipeline:` tag, even for a caller that passes none", () => {
    // The tag is a PURGE HANDLE: it is what lets a pipeline change be purged
    // explicitly, without a deploy. (It is NOT what makes a PIPELINE_VERSION
    // bump invalidate cached renders on deploy — worker-version-in-key does
    // that, transitively. See the note in src/lib/cache.ts.)
    const ctx = context();
    markPublicCacheable(ctx, []);
    expect(ctx.cache.set).toHaveBeenCalledWith(
      expect.objectContaining({ tags: [`pipeline:${PIPELINE_VERSION}`] }),
    );
  });

  it("⚠️ REFUSES to cache a render carrying a session cookie", () => {
    // ⚠️ THE REGRESSION THIS FILE EXISTS FOR. Cookie is NOT in the cache key and
    // does NOT bypass: a cacheable authed render is served to EVERYONE.
    const ctx = context(`${SESSION_COOKIE_NAME}=abc`);
    expect(markPublicCacheable(ctx, ["post:1"])).toBe(false);
    expect(ctx.cache.set).toHaveBeenCalledWith(false);
    expect(ctx.cache.set).not.toHaveBeenCalledWith(expect.objectContaining({ maxAge: expect.anything() }));
  });

  it("⚠️ REFUSES a render that is MINTING a session (response carries Set-Cookie)", () => {
    // ⚠️ THE REQUEST LOOKS ANONYMOUS AND IS NOT. A successful login/signup render
    // arrives with NO cookie (there is no session yet) and leaves with one, so
    // `hasViewerState` — which reads the REQUEST — sees nothing to refuse.
    //
    // Cloudflare does bypass its cache on `Set-Cookie`, but this file's own
    // header says relying on that makes correctness depend on a side effect a
    // page has no reason to produce. Depending on it in exactly the case it
    // warns about would be incoherent. So refuse on our own terms.
    const ctx = context();
    ctx.response.headers.set("set-cookie", `${SESSION_COOKIE_NAME}=fresh; HttpOnly`);
    expect(markPublicCacheable(ctx, ["post:1"])).toBe(false);
    expect(ctx.cache.set).toHaveBeenCalledWith(false);
  });

  it("passes ONLY maxAge/swr/tags into cache.set() — never an s-maxage-shaped key", () => {
    // ⚠️ THIS TEST CANNOT READ THE REAL RESPONSE HEADER. `ctx.cache.set` here is
    // a bare `vi.fn()` spy with no implementation, so `ctx.response.headers` is
    // NEVER mutated by it — reading `ctx.response.headers.get(...)` after this
    // call is always empty, regardless of header name. All this unit test can
    // pin is the CALL SHAPE we control. The REAL emitted bytes are asserted in
    // the "against the REAL Astro cache runtime" block at the bottom of this
    // file, which drives the actual provider.
    const ctx = context();
    markPublicCacheable(ctx, ["x"]);
    expect(ctx.cache.set).toHaveBeenCalledWith({
      maxAge: expect.any(Number),
      swr: expect.any(Number),
      tags: expect.any(Array),
    });
  });
});

describe("markFeedCacheable (untagged, TTL-only)", () => {
  it("uses the SHORT window and NO tags", () => {
    const ctx = context();
    expect(markFeedCacheable(ctx)).toBe(true);
    // ⚠️ No tags is deliberate: this is the one shape that may read through
    // HYPERDRIVE_CACHED, and that is only sound while nothing purges it.
    expect(ctx.cache.set).toHaveBeenCalledWith({ maxAge: 60, swr: 600, tags: [] });
  });

  it("still refuses an authed render", () => {
    const ctx = context(`${SESSION_COOKIE_NAME}=abc`);
    expect(markFeedCacheable(ctx)).toBe(false);
    expect(ctx.cache.set).toHaveBeenCalledWith(false);
  });

  it("also refuses a render minting a session", () => {
    const ctx = context();
    ctx.response.headers.set("set-cookie", "x=1");
    expect(markFeedCacheable(ctx)).toBe(false);
    expect(ctx.cache.set).toHaveBeenCalledWith(false);
  });
});

describe("markPrivate", () => {
  it("disables caching and says so in the header", () => {
    const ctx = context();
    markPrivate(ctx);
    expect(ctx.cache.set).toHaveBeenCalledWith(false);
    expect(ctx.response.headers.get("cache-control")).toBe("private, no-store");
  });
});

/**
 * ⚠️ THE ANTI-VACUITY BLOCK — the only assertions here that read REAL BYTES.
 *
 * Everything above drives a `vi.fn()` spy, so it can only pin the call shape we
 * ourselves chose. That is exactly the trap Task 12's review caught: a test that
 * reads a header nothing ever writes passes forever, no matter what it asserts.
 *
 * So this block wires the helpers to the ACTUAL machinery: astro's real
 * `AstroCache` + the real `@astrojs/cloudflare` provider + a real `Response`,
 * and asserts the bytes that come out. Crucially it asserts the PUBLIC case
 * POSITIVELY first — `cloudflare-cdn-cache-control` is present and non-empty
 * with an exact value — which is what proves the PRIVATE case's negative
 * assertion (that the same header is absent) is measuring something real rather
 * than reading a header name that is always null.
 *
 * ⚠️ WHY A FILE-URL IMPORT. `astro/dist/core/cache/runtime/cache.js` is not in
 * astro's `exports` map, so it cannot be imported by specifier. Resolving it
 * from the package root (the same idiom test/workers-cache.test.ts uses to read
 * the adapter's source) is the only way to drive the real cache object from
 * here. If an astro bump moves this file, this block fails loudly — which is the
 * correct outcome: it means the runtime these helpers target has changed shape.
 */
const require_ = createRequire(import.meta.url);
const astroRoot = dirname(require_.resolve("astro/package.json"));
const { AstroCache, applyCacheHeaders } = (await import(
  pathToFileURL(join(astroRoot, "dist/core/cache/runtime/cache.js")).href
)) as {
  AstroCache: new (provider: unknown) => CacheContext["cache"];
  applyCacheHeaders: (cache: unknown, response: Response, request: Request) => void;
};

describe("⚠️ against the REAL Astro cache runtime + the REAL Cloudflare provider", () => {
  const provider = cacheProviderFactory(undefined);

  /** A context whose `cache` is a genuine `AstroCache`, not a spy. */
  function realContext(cookie?: string) {
    const request = new Request("https://thinkersjournal.com/@a/b", {
      headers: cookie === undefined ? {} : { Cookie: cookie },
    });
    const response = new Response("<html>hi</html>");
    const cache = new AstroCache(provider);
    return { ctx: { request, response, cache } as CacheContext, response, request, cache };
  }

  /** Run the render's cache decision all the way out to the response headers. */
  function emit(c: ReturnType<typeof realContext>) {
    applyCacheHeaders(c.cache, c.response, c.request);
    return c.response.headers;
  }

  it("an ANONYMOUS public render emits real, non-empty Cloudflare cache directives", () => {
    const c = realContext();
    markPublicCacheable(c.ctx, ["post:1", "author:2"]);
    const headers = emit(c);

    // ⚠️ POSITIVE FIRST — this is what makes every negative assertion below
    // meaningful. The header exists, is non-empty, and has an exact value.
    const directives = headers.get("cloudflare-cdn-cache-control");
    expect(directives).not.toBeNull();
    expect(directives).not.toBe("");
    expect(directives).toBe("public, max-age=3600, stale-while-revalidate=86400");

    // Only NOW is asserting an absence worth anything.
    expect(directives).not.toContain("s-maxage");
    expect(directives).not.toContain("must-revalidate");

    // The tags really do reach the wire, pipeline handle included.
    expect(headers.get("cache-tag")).toBe(`post:1,author:2,pipeline:${PIPELINE_VERSION},astro-path:/@a/b`);
  });

  it("⚠️ an AUTHED render emits NO cacheable directive at all — the leak this task exists to deny", () => {
    const c = realContext(`${SESSION_COOKIE_NAME}=abc`);
    markPublicCacheable(c.ctx, ["post:1"]);
    const headers = emit(c);

    // ⚠️ The assertion above proves this header IS written for an anonymous
    // render through this exact code path. So its absence here is a real,
    // measured difference — not a header name that is null no matter what.
    expect(headers.get("cloudflare-cdn-cache-control")).toBeNull();
    expect(headers.get("cache-tag")).toBeNull();
    // And the render says so in its own right, for any cache that never sees
    // the adapter's stamp (a browser, an intermediary).
    expect(headers.get("cache-control")).toBe("private, no-store");
  });

  it("⚠️ a render MINTING a session emits no cacheable directive", () => {
    const c = realContext();
    c.response.headers.set("set-cookie", `${SESSION_COOKIE_NAME}=fresh; HttpOnly`);
    markPublicCacheable(c.ctx, ["post:1"]);
    const headers = emit(c);
    expect(headers.get("cloudflare-cdn-cache-control")).toBeNull();
    expect(headers.get("cache-control")).toBe("private, no-store");
  });

  it("⚠️ documents the ORDERING LIMIT of the Set-Cookie check — it is call-time, not response-time", () => {
    // ⚠️ READ THIS BEFORE TRUSTING THE CHECK ABOVE. `markPublicCacheable` can
    // only inspect the response AS IT IS WHEN CALLED. Pages call their helper at
    // the TOP of frontmatter, and `applyCookies(Astro.response.headers, …)` runs
    // LATER — so a cookie minted after the declaration is INVISIBLE to it, and
    // the render is marked cacheable regardless.
    //
    // This is pinned rather than hidden because it bounds what §4's fix actually
    // buys: it closes the gap when the cookie is already applied, and it does
    // NOT make "a public page may mint a session" safe. The real defense remains
    // structural and unchanged — a page that mints a session is markPrivate, and
    // public pages render fully anonymous and never mint cookies at all. A
    // response-time guarantee would need middleware, not a call-time helper.
    const c = realContext();
    markPublicCacheable(c.ctx, ["post:1"]); // declared FIRST — response is clean here
    c.response.headers.set("set-cookie", `${SESSION_COOKIE_NAME}=late; HttpOnly`); // minted AFTER
    const headers = emit(c);
    expect(headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=3600, stale-while-revalidate=86400");
  });

  it("markPrivate emits no cacheable directive either", () => {
    const c = realContext();
    markPrivate(c.ctx);
    const headers = emit(c);
    expect(headers.get("cloudflare-cdn-cache-control")).toBeNull();
    expect(headers.get("cache-control")).toBe("private, no-store");
  });

  it("a feed render emits the SHORT window and no tags but astro's own", () => {
    const c = realContext();
    markFeedCacheable(c.ctx);
    const headers = emit(c);
    expect(headers.get("cloudflare-cdn-cache-control")).toBe(
      `public, max-age=${FEED_MAX_AGE}, stale-while-revalidate=${FEED_SWR}`,
    );
  });

  it("⚠️ documents that cache.set(false) is NOT STICKY — a later set() re-enables caching", () => {
    // ⚠️ VERIFIED AGAINST THE INSTALLED astro@7.0.9 (runtime/cache.js): `set(false)`
    // sets `#disabled = true`, but ANY subsequent `set({...})` sets it straight
    // back to `false`. So "refuse, then someone else opts in" silently WINS for
    // the opt-in — the refusal is not a latch.
    //
    // This is why `markPrivate` is not sufficient on its own and why
    // test/page-cache-inventory.test.ts forbids pages from calling `cache.set()`
    // directly and requires EXACTLY ONE helper per page: with one declaration
    // per page there is no second call to undo the first. If a future astro
    // makes `set(false)` sticky this test fails — that would be GOOD news, and
    // the comment above (not the guard) is what should change.
    const c = realContext(`${SESSION_COOKIE_NAME}=abc`);
    markPublicCacheable(c.ctx, ["post:1"]); // refuses -> set(false)
    c.cache.set({ maxAge: 3600, swr: 86400, tags: [] }); // an imagined second caller
    const headers = emit(c);
    expect(headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=3600, stale-while-revalidate=86400");
  });
});
