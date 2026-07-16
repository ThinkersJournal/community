import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE PUBLIC POST PAGE — src/pages/[handle]/[slug].astro.
 *
 * ⚠️ WHY THIS IS A SOURCE/STRUCTURE TEST, NOT A RENDER. This app's vitest is
 * plain Node (see vitest.config.ts), and the page imports `cloudflare:workers`
 * (via src/lib/api.ts) and calls the real markdown pipeline — neither runs
 * outside the Workers pool, and mocking the `API` Service Binding would test the
 * mock, not the page. The page's RUNTIME behaviour is proven where it is real:
 * on the wire under `wrangler dev` (200 + body + the exact headers, a draft ->
 * 404, an authed request -> `no-store` and no cache-tag — captured in
 * .superpowers/sdd/m1-task-15-report.md), and by the E2E spine.
 *
 * What THIS file pins is the set of load-bearing invariants that are otherwise
 * enforced only by code review and are INVISIBLE to every other test — the ones
 * whose regression is a silent leak or a silent 404, not a red test:
 *   • the ROUTING SHAPE that dodges both documented traps (`@[username]` dirs and
 *     `_`-prefixed segments Astro skips without warning);
 *   • ANONYMOUS BY CONSTRUCTION — the public fetch forwards no browser request;
 *   • a not-found NEVER declares cacheability (it returns before the helper);
 *   • the three purge-matched cache tags; the CSP; the ld+json escape.
 *
 * ⚠️ ANTI-VACUITY: every negative below is preceded by a POSITIVE that proves we
 * are looking at the real construct (the call exists, the fetch exists) — a bare
 * `not.toContain` over source text that moved would pass while proving nothing.
 */

const PAGES_DIR = join(import.meta.dirname, "../src/pages");
const PAGE = join(PAGES_DIR, "[handle]", "[slug].astro");

/**
 * Strip comments so PROSE cannot satisfy an assertion — the page's header talks
 * about `request` and cache tags at length, and a match there would be
 * meaningless. Same technique as test/page-cache-inventory.test.ts.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const rawSource = readFileSync(PAGE, "utf8");
const code = stripComments(rawSource);

describe("routing shape — the two documented traps", () => {
  it("lives at [handle]/[slug].astro exactly", () => {
    // A literal `@[username]` directory is unverified in Astro 7; `[handle]` +
    // an explicit startsWith("@") check is the shape that provably routes.
    expect(existsSync(PAGE)).toBe(true);
  });

  it("⚠️ has NO `_`-prefixed segment and NO `@`-prefixed directory under src/pages", () => {
    // Astro's router SILENTLY skips any file OR directory whose name starts with
    // `_` (T14's headline: a 404 in prod while every unit test passes), and a
    // literal `@` directory is the trap this page's `[handle]` design avoids.
    // Walk the whole tree so a future page cannot reintroduce either.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith("_") || entry.name.startsWith("@")) {
          offenders.push(join(dir, entry.name).replace(/\\/g, "/").split("src/pages/")[1] ?? entry.name);
        }
        if (entry.isDirectory()) walk(join(dir, entry.name));
      }
    };
    walk(PAGES_DIR);
    expect(offenders).toEqual([]);
  });

  it("guards the handle with an explicit startsWith(\"@\") 404", () => {
    // The check that turns /foo/bar into a real 404 and strips the @ to a username.
    expect(code).toMatch(/handle\.startsWith\(\s*["']@["']\s*\)/);
    expect(code).toMatch(/status:\s*404/);
  });
});

describe("⚠️ anonymous by construction — the leak defense", () => {
  it("reads exactly the anonymous public endpoint", () => {
    // Positive: the page's data source is the anonymous public read, whose api
    // handler reads no session at all (apps/api/src/routes/public.ts).
    expect(code).toContain("apiFetch");
    expect(code).toMatch(/\/public\/posts\?username=/);
  });

  it("⚠️ forwards NO browser request to the api — nothing to personalize, nothing to leak", () => {
    // THE property that makes a cached render safe: the api call omits `request`,
    // so src/lib/api.ts never forwards the Cookie, so the api cannot resolve a
    // session, so there is no viewer-specific value in the render. If someone
    // adds `request: Astro.request` to "personalize" this page, its render
    // becomes viewer-specific AND cacheable — a mass session leak — and THIS
    // reddens. (Positive above proved the fetch exists; these negatives are
    // therefore not vacuous.)
    expect(code).not.toContain("Astro.request");
    expect(code).not.toMatch(/\brequest:/);
  });
});

describe("cacheability + purge tags", () => {
  it("declares itself public-cacheable via the one helper", () => {
    // Positive presence — the inventory test proves it is the ONLY helper called;
    // this proves it is THIS one (public), not markPrivate.
    expect(code).toContain("markPublicCacheable(Astro,");
  });

  it("⚠️ passes exactly the three tags apps/api/src/cache/purge.ts purges by", () => {
    // Cross-checked against apps/api/src/routes/posts.ts call sites:
    //   publish -> [`author:${authorId}`, "listing"]
    //   edit    -> [`post:${updated.id}`, `author:${authorId}`, "listing"]
    // A typo here is invisible locally (miniflare does not simulate Workers
    // Cache); its only symptom is edits that never invalidate. `pipeline:v1` is
    // appended by the helper itself, not here.
    expect(code).toContain("`post:${post.id}`");
    expect(code).toContain("`author:${post.authorId}`");
    expect(code).toMatch(/["']listing["']/);
  });

  it("⚠️ a NOT-FOUND returns BEFORE it ever declares cacheability", () => {
    // So a 404 emits no opt-in and the adapter stamps `no-store` — a not-found is
    // uncached, fail-closed. Proven by ordering: the not-found guard precedes the
    // cache declaration in source.
    const notFoundAt = code.indexOf("response.status !== 200");
    const cacheAt = code.indexOf("markPublicCacheable(");
    expect(notFoundAt).toBeGreaterThan(-1);
    expect(cacheAt).toBeGreaterThan(-1);
    expect(notFoundAt).toBeLessThan(cacheAt);
  });
});

describe("security headers + the ld+json escape", () => {
  it("applies the public-page CSP", () => {
    expect(code).toContain("setPublicPageCsp(Astro)");
  });

  it("⚠️ serialises ld+json through jsonLdScript, never a bare JSON.stringify", () => {
    // jsonLdScript escapes `<`, which a bare JSON.stringify does not — the title
    // path bypasses the Markdown sanitizer, so this is the only guard in front of
    // a `</script>` breakout. Positive: it is used. Negative: the script block
    // does not hand-roll JSON.stringify.
    expect(code).toContain("jsonLdScript(");
    expect(code).toMatch(/set:html=\{jsonLdScript\(/);
    expect(code).not.toMatch(/set:html=\{JSON\.stringify\(/);
  });

  it("marks the ld+json block is:inline so Astro does not bundle it away", () => {
    expect(rawSource).toMatch(/<script\s+is:inline\s+type="application\/ld\+json"/);
  });
});

/**
 * MANIFEST REACHABILITY — build-gated, because it needs the build output.
 *
 * ⚠️ The `_`/`@` traps are silent at build time: the route simply never enters
 * the manifest. When a build exists we prove the OPPOSITE positively — the route
 * IS in it — and that neither trap-shaped route leaked in. When there is no
 * build (a bare `pnpm test` in CI), this is covered by the deploy gate and the
 * on-the-wire capture in the report instead of asserted vacuously.
 */
describe("built route manifest (when dist/ is present)", () => {
  const serverDir = join(import.meta.dirname, "../dist/server");
  const built = existsSync(serverDir);

  it.runIf(built)("contains the /[handle]/[slug] route and neither trap route", () => {
    const manifest = readdirSync(serverDir)
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => readFileSync(join(serverDir, f), "utf8"))
      .join("\n");
    expect(manifest).toContain('"route":"/[handle]/[slug]"');
    // Positive proved; now the `@[username]` trap route must be absent. (The
    // `_`-prefix trap is covered build-independently by the src/pages source
    // walk above; here it would collide with Astro's own legitimate `/_image`
    // and `/_server-islands` internal routes.)
    expect(manifest).not.toContain('"route":"/@');
  });

  it.skipIf(built)("SKIPPED: no dist/ — reachability is deploy-gate + report-verified", () => {
    expect(built).toBe(false);
  });
});
