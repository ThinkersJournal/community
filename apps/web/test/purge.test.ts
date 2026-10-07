import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handlePurgeRequest } from "../src/lib/purge";
import { readRouteManifest, serverBuilt } from "./helpers/route-manifest";

import type { PurgeContext, PurgeFailureLimiter } from "../src/lib/purge";

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
 * ⚠️ AN EARLIER VERSION OF THIS BLOCK WAS ITSELF VACUOUS — it asserted
 * `["internal", "purge.ts"].startsWith("_") === false` over a HARDCODED literal, so
 * it never touched the filesystem and could never fail. That is the same
 * always-passes anti-pattern this task exists to stamp out, decorating the very
 * finding it was written for. It now walks the real `src/pages` tree.
 */
const PAGES_DIR = join(import.meta.dirname, "../src/pages");
const ROUTE_FILE = join(PAGES_DIR, "internal/purge.ts");

/** Every file under `dir`, recursively. Mirrors page-cache-inventory.test.ts. */
function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

describe("⚠️ the purge route is ROUTABLE (not just correct)", () => {
  it("lives where api dispatches: src/pages/internal/purge.ts -> POST /internal/purge", () => {
    expect(existsSync(ROUTE_FILE), `${ROUTE_FILE} does not exist`).toBe(true);
  });

  it("NO page anywhere under src/pages has an underscore-prefixed segment", () => {
    // ⚠️ A REPO-WIDE TRIPWIRE, not a check of this one route: it also catches
    // someone adding a `_dir/` or `_file.ts` elsewhere under src/pages and quietly
    // losing that route. Every file under src/pages here is a real route — the
    // cacheability inventory already requires each one to declare itself — so
    // Astro's "underscore means private helper" convention has no legitimate use
    // in this tree. If you want a private module, put it in src/lib or
    // src/components, NOT under src/pages.
    const offenders = allFiles(PAGES_DIR)
      .map((f) => f.replace(/\\/g, "/").split("src/pages/")[1] ?? f)
      .filter((rel) => rel.split("/").some((segment) => segment.startsWith("_")));

    expect(
      offenders,
      `these files under src/pages have an "_"-prefixed segment, so Astro's router SKIPS them and they 404 with no warning anywhere (dist/core/routing/create-manifest.js: 'if (name[0] === "_") { continue; }'): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  // ⚠️ BUILD-GATED, and it is the only test here that proves ROUTABILITY rather
  // than a PROXY for it. The two above pin the file's LOCATION, which is a proxy
  // with slack: if Astro's rules shift, or `prerender = false` is dropped from the
  // route, they stay green while the route dies exactly as it did before. This
  // greps the real built manifest. Skipped without a build (a fresh clone has no
  // dist/), which is why it backs the location tests up rather than replacing them;
  // `pnpm exec playwright test` always builds first, so CI does exercise it.
  it.skipIf(!serverBuilt)(
    "is present in the BUILT server manifest (the only real proof)",
    () => {
      const manifest = readRouteManifest();
      expect(
        manifest.includes('"route":"/internal/purge"'),
        'dist/server has no "route":"/internal/purge" anywhere under it. The route did not survive the build — Astro dropped it (an "_"-prefixed segment?) or it was moved. api will POST into a 404 and every purge will silently fail.',
      ).toBe(true);
    },
  );
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

/** A limiter that always allows — for the cases that are not about rate limiting. */
function allowAll(): PurgeFailureLimiter & { limit: ReturnType<typeof vi.fn> } {
  return { limit: vi.fn(async () => ({ success: true })) };
}

/**
 * A per-key fixed-window counter with the binding's contract: `success: false`
 * once a key has been seen `limit` times. Enough to drive "repeated 403s become
 * 429s" without a real binding (this suite is plain Node).
 */
function countingLimiter(limit: number): PurgeFailureLimiter & { limit: ReturnType<typeof vi.fn> } {
  const counts = new Map<string, number>();
  return {
    limit: vi.fn(async ({ key }: { key: string }) => {
      const n = counts.get(key) ?? 0;
      if (n >= limit) return { success: false };
      counts.set(key, n + 1);
      return { success: true };
    }),
  };
}

/** A purge request from the public internet: `CF-Connecting-IP` is set by Cloudflare's edge. */
const fromIp = (ip: string, secret: string) =>
  context(
    { "X-Purge-Secret": secret, "content-type": "application/json", "CF-Connecting-IP": ip },
    JSON.stringify({ tags: ["post:1"] }),
  );

/** Each `console.warn` call that is a `security:` event, flattened to one string. */
function securityLines(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls
    .filter((args) => typeof args[0] === "string" && args[0].startsWith("security:"))
    .map((args) => JSON.stringify(args));
}

describe("handlePurgeRequest — authorization", () => {
  it("authorizes the correct secret and invalidates the tags", async () => {
    // ⚠️ THE ANTI-VACUITY ANCHOR for every `not.toHaveBeenCalled()` below.
    const ctx = withSecret(SECRET);
    const response = await handlePurgeRequest(ctx, SECRET, allowAll());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ purged: 2 });
    // ⚠️ INSIDE THIS WORKER'S ENTRYPOINT — the only scope where this reaches the
    // cache holding our rendered HTML. One call, every tag.
    expect(ctx.cache.invalidate).toHaveBeenCalledTimes(1);
    expect(ctx.cache.invalidate).toHaveBeenCalledWith({ tags: ["post:1", "listing"] });
  });

  it("REJECTS a wrong secret, and purges nothing", async () => {
    const ctx = withSecret("wrong-secret-of-the-same-length-000000");
    const response = await handlePurgeRequest(ctx, SECRET, allowAll());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "FORBIDDEN" });
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("REJECTS a secret that is merely a PREFIX of the real one", async () => {
    // timingSafeEqual compares SHA-256 digests, and a prefix digests differently
    // from the whole, so the characters that do line up never count as a match.
    const ctx = withSecret(SECRET.slice(0, 10));
    expect((await handlePurgeRequest(ctx, SECRET, allowAll())).status).toBe(403);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("REJECTS a MISSING secret header", async () => {
    const ctx = context({ "content-type": "application/json" }, JSON.stringify({ tags: ["x"] }));
    expect((await handlePurgeRequest(ctx, SECRET, allowAll())).status).toBe(403);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("⚠️ FAILS CLOSED when the binding's secret is UNDEFINED", async () => {
    // An unset PURGE_SECRET must never make every caller authorized. This is the
    // shape of a real deploy mistake: `wrangler secret put` run on api but not web.
    const ctx = withSecret(SECRET);
    expect((await handlePurgeRequest(ctx, undefined, allowAll())).status).toBe(403);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("⚠️ FAILS CLOSED when the binding's secret is EMPTY, even for an empty header", async () => {
    // Without the explicit `=== ""` guard, `timingSafeEqual("", "")` is TRUE and
    // an empty secret authorizes the entire internet.
    const ctx = withSecret("");
    expect((await handlePurgeRequest(ctx, "", allowAll())).status).toBe(403);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });
});

describe("handlePurgeRequest — input", () => {
  it("400s on a malformed JSON body, and purges nothing", async () => {
    const ctx = context({ "X-Purge-Secret": SECRET }, "not json{");
    const response = await handlePurgeRequest(ctx, SECRET, allowAll());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_JSON" });
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("400s on an empty tag list rather than purging nothing expensively", async () => {
    const ctx = withSecret(SECRET, []);
    const response = await handlePurgeRequest(ctx, SECRET, allowAll());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_INPUT", fields: ["tags"] });
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("400s when `tags` is ABSENT", async () => {
    // Built by hand, NOT via `withSecret(SECRET, undefined)` — that argument hits
    // the helper's DEFAULT and would silently send the real tags, making this
    // assert 200 === 400. The omitted key has to actually be omitted.
    const ctx = context({ "X-Purge-Secret": SECRET }, JSON.stringify({}));
    expect((await handlePurgeRequest(ctx, SECRET, allowAll())).status).toBe(400);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("400s when `tags` is not an array", async () => {
    const ctx = withSecret(SECRET, "listing");
    expect((await handlePurgeRequest(ctx, SECRET, allowAll())).status).toBe(400);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("400s on a JSON body that is not an object at all", async () => {
    // `null.tags` would throw a TypeError and 500 the route; `"[]".tags` is
    // undefined. Both must land on the same 400.
    for (const body of ["null", "[]", '"a string"', "42"]) {
      const ctx = context({ "X-Purge-Secret": SECRET }, body);
      expect((await handlePurgeRequest(ctx, SECRET, allowAll())).status).toBe(400);
    }
  });

  it("drops non-string and empty tags rather than forwarding junk to the purge API", async () => {
    const ctx = withSecret(SECRET, ["post:1", 42, "", null, "listing"]);
    const response = await handlePurgeRequest(ctx, SECRET, allowAll());
    expect(response.status).toBe(200);
    expect(ctx.cache.invalidate).toHaveBeenCalledWith({ tags: ["post:1", "listing"] });
  });

  it("400s when EVERY tag was junk (nothing survived the filter)", async () => {
    const ctx = withSecret(SECRET, [42, "", null]);
    expect((await handlePurgeRequest(ctx, SECRET, allowAll())).status).toBe(400);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });
});

/**
 * ⚠️ BRUTE-FORCE COUNTERMEASURES (audit 2026-10-06, item #23). `/internal/purge` is
 * on the PUBLIC Worker, guarded only by the shared secret. These pin:
 *   - a wrong secret of a DIFFERENT length is refused (the compare is now
 *     length-safe: packages/shared/src/timing-safe.ts hashes both sides);
 *   - repeated failures from one IP become 429s;
 *   - the api's AUTHORIZED purge is never throttled — it never touches the
 *     limiter at all, whatever headers the Service Binding hop carries;
 *   - every 403 writes a `security:` line with the IP and a timestamp, never the
 *     submitted value.
 */
describe("handlePurgeRequest — brute-force countermeasures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("REFUSES a wrong secret of a DIFFERENT (longer) length", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = withSecret(`${SECRET}-and-then-some-more-characters`);
    expect((await handlePurgeRequest(ctx, SECRET, allowAll())).status).toBe(403);
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
  });

  it("429s repeated failures from ONE IP once over the failure limit, and purges nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const limiter = countingLimiter(5);
    for (let i = 0; i < 5; i++) {
      const ctx = fromIp("198.51.100.7", `wrong-${i}`);
      expect((await handlePurgeRequest(ctx, SECRET, limiter)).status, `failure ${i + 1}`).toBe(403);
    }
    const ctx = fromIp("198.51.100.7", "wrong-again");
    const response = await handlePurgeRequest(ctx, SECRET, limiter);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ code: "RATE_LIMITED" });
    expect(ctx.cache.invalidate).not.toHaveBeenCalled();
    // Keyed on the client IP, not on anything the caller submitted.
    expect(limiter.limit).toHaveBeenCalledWith({ key: "purge-fail:198.51.100.7" });
  });

  it("CONTROL: another IP's failures do not count against this one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const limiter = countingLimiter(5);
    for (let i = 0; i < 6; i++) await handlePurgeRequest(fromIp("198.51.100.7", "wrong"), SECRET, limiter);
    expect((await handlePurgeRequest(fromIp("198.51.100.7", "wrong"), SECRET, limiter)).status).toBe(429);
    expect((await handlePurgeRequest(fromIp("198.51.100.8", "wrong"), SECRET, limiter)).status).toBe(403);
  });

  it("the AUTHORIZED api purge is never throttled: it does not consume limiter quota at all", async () => {
    // The api's purge (apps/api/src/cache/purge.ts) sends only content-type and
    // X-Purge-Secret over the Service Binding. Whether or not the platform adds a
    // CF-Connecting-IP to that hop, an authorized request must never reach the
    // limiter — so an exhausted limiter cannot stop it.
    const exhausted: PurgeFailureLimiter & { limit: ReturnType<typeof vi.fn> } = {
      limit: vi.fn(async () => ({ success: false })),
    };
    for (const ctx of [withSecret(SECRET), fromIp("198.51.100.7", SECRET)]) {
      const response = await handlePurgeRequest(ctx, SECRET, exhausted);
      expect(response.status).toBe(200);
      expect(ctx.cache.invalidate).toHaveBeenCalledTimes(1);
    }
    expect(exhausted.limit).not.toHaveBeenCalled();
  });

  it("logs every 403 as a `security:` line with the client IP and a timestamp, never the submitted value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const submitted = "a-guess-that-must-never-be-logged";
    expect((await handlePurgeRequest(fromIp("198.51.100.9", submitted), SECRET, allowAll())).status).toBe(403);

    const lines = securityLines(warn);
    expect(lines, `saw ${JSON.stringify(warn.mock.calls)}`).toHaveLength(1);
    expect(lines[0]).toContain("auth_failure");
    expect(lines[0]).toContain("/internal/purge");
    expect(lines[0]).toContain("198.51.100.9");
    expect(lines[0]).toMatch(/"at":"\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(submitted);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it("keys an IPv6 failure on its /64, so rotating inside the /64 shares one bucket", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const limiter = countingLimiter(5);
    for (let i = 1; i <= 5; i++) {
      expect((await handlePurgeRequest(fromIp(`2001:db8:1:2::${i}`, "wrong"), SECRET, limiter)).status).toBe(403);
    }
    expect((await handlePurgeRequest(fromIp("2001:db8:1:2:aaaa::9", "wrong"), SECRET, limiter)).status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledWith({ key: "purge-fail:2001:db8:1:2::/64" });
    // CONTROL: another /64 is untouched.
    expect((await handlePurgeRequest(fromIp("2001:db8:1:3::1", "wrong"), SECRET, limiter)).status).toBe(403);
  });

  it("logs the 429 too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocked: PurgeFailureLimiter = { limit: async () => ({ success: false }) };
    expect((await handlePurgeRequest(fromIp("198.51.100.10", "wrong"), SECRET, blocked)).status).toBe(429);
    expect(securityLines(warn).some((l) => l.includes("rate_limited") && l.includes("198.51.100.10"))).toBe(true);
  });

  it("a failure with NO client IP is refused and logged, but not pooled into one shared bucket", async () => {
    // No CF-Connecting-IP means this did not come through Cloudflare's public
    // edge (which always sets it). One shared "unknown" bucket would let anyone
    // who could send such a request spend it for everyone, so it is skipped.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limiter = allowAll();
    const ctx = withSecret("wrong");
    expect((await handlePurgeRequest(ctx, SECRET, limiter)).status).toBe(403);
    expect(limiter.limit).not.toHaveBeenCalled();
    expect(securityLines(warn)).toHaveLength(1);
  });
});

/**
 * ⚠️ EVERY `timingSafeEqual` CALL MUST BE AWAITED — repo-wide. It became async when
 * it started hashing both sides (packages/shared/src/timing-safe.ts). An un-awaited
 * call yields a Promise, which is TRUTHY: `if (timingSafeEqual(a, b))` authorizes
 * everyone, and `!timingSafeEqual(a, b)` refuses no one. That is not hypothetical —
 * the moment the compare went async, every refusal case in this file answered 200
 * until src/lib/purge.ts awaited it. TypeScript's `strict` does not flag `!promise`,
 * and this repo runs no no-misused-promises lint, so this is the guard.
 *
 * Enumerated from TRACKED files (`git grep`), not a disk walk, so another
 * checkout's files cannot leak in. The positive control is the population itself:
 * the two known callers (api's csrf.ts and web's purge.ts) must be found.
 *
 * ⚠️ KNOWN GAPS (review 1, M4) — this is a text scan, not a type check:
 *   - an ALIASED import (`import { timingSafeEqual as tse }` … `if (tse(a, b))`)
 *     matches nothing and passes;
 *   - a string literal containing `/*` can make the comment stripper swallow
 *     real code up to the next `*\/`;
 *   - locally, a new caller in an UNTRACKED file is invisible to `git grep`
 *     until it is staged (CI checks out a commit, so it is unaffected);
 *   - it says nothing about OTHER async auth helpers, e.g. purge.ts's own
 *     `authorized()` — the behavioural refusal tests above catch a dropped
 *     await there.
 * The complete fix is the `@typescript-eslint/no-misused-promises` lint
 * repo-wide; until then, this guard plus the behavioural tests.
 */
describe("⚠️ every timingSafeEqual call site awaits it", () => {
  it("finds the known callers, and each call is awaited", () => {
    const root = join(import.meta.dirname, "../../..");
    // `git grep -l` searches only TRACKED files, so it is the index-bounded
    // enumeration without reading every file in the repo (a full read timed out).
    const files = execFileSync("git", ["grep", "-l", "-e", "timingSafeEqual", "--", "*.ts", "*.astro"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => f !== "" && !f.includes("/test/") && !f.endsWith(".d.ts"));

    const callers: string[] = [];
    const unawaited: string[] = [];
    for (const rel of files) {
      // Comments mention the function in prose (`timingSafeEqual("", "")`…); only
      // code counts. Crude but sufficient: strip block and line comments.
      const source = readFileSync(join(root, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const match of source.matchAll(/(\w+\s+)?timingSafeEqual\(/g)) {
        const before = match[1]?.trim();
        // The definition itself (`function timingSafeEqual(`) is not a call.
        if (before === "function") continue;
        callers.push(rel);
        if (before !== "await") unawaited.push(`${rel}: …${match[0]}`);
      }
    }

    expect(callers, `the population: ${JSON.stringify(callers)}`).toEqual(
      expect.arrayContaining(["apps/api/src/auth/csrf.ts", "apps/web/src/lib/purge.ts"]),
    );
    expect(unawaited, "un-awaited timingSafeEqual calls authorize everyone (a Promise is truthy)").toEqual([]);
  }, 30_000);
});
