import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE PUBLIC PROFILE PAGE — src/pages/[handle]/index.astro.
 *
 * ⚠️ SOURCE/STRUCTURE TEST, NOT A RENDER — same reasoning as test/post-page.test.ts.
 * This app's vitest is plain Node (see vitest.config.ts); the page imports
 * `cloudflare:workers` (via src/lib/api.ts), which does not run outside the
 * Workers pool. The page's RUNTIME behaviour is proven on the wire under
 * `wrangler dev` (captured in .superpowers/sdd/m1-task-16-report.md) and by the
 * E2E spine.
 *
 * What THIS file pins is the set of load-bearing invariants that are otherwise
 * enforced only by code review and are INVISIBLE to every other test — the ones
 * whose regression is a silent leak, a silent 404, or a silent SQL error, not a
 * red test:
 *   • the routing shape (`[handle]/index.astro`, the `@` guard, the empty-username
 *     guard);
 *   • ANONYMOUS BY CONSTRUCTION — the public fetch forwards no browser request;
 *   • the KEYSET cursor contract — `?cursor=` forwarded opaquely, `ORDER BY id
 *     DESC` reasoning documented, a non-200 (draft author, unknown user, OR the
 *     api's 400 on a malformed cursor) collapses to a single 404 rather than a
 *     crash;
 *   • a not-found never declares cacheability;
 *   • the two purge-matched cache tags; the CSP; excerpts never set:html'd.
 *
 * ⚠️ ANTI-VACUITY: every negative below is preceded by a POSITIVE that proves we
 * are looking at the real construct — a bare `not.toContain` over source text
 * that moved would pass while proving nothing.
 */

const PAGES_DIR = join(import.meta.dirname, "../src/pages");
const PAGE = join(PAGES_DIR, "[handle]", "index.astro");

/**
 * Strip comments so PROSE cannot satisfy an assertion — same technique as
 * test/post-page.test.ts and test/page-cache-inventory.test.ts.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const rawSource = readFileSync(PAGE, "utf8");
const code = stripComments(rawSource);

describe("routing shape", () => {
  it("lives at [handle]/index.astro exactly (sibling of [handle]/[slug].astro)", () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it("guards the handle with an explicit startsWith(\"@\") 404", () => {
    expect(code).toMatch(/handle\.startsWith\(\s*["']@["']\s*\)/);
    expect(code).toMatch(/status:\s*404/);
  });

  it("⚠️ 404s an empty username (`/@` with nothing after it), not just a missing handle", () => {
    // Positive: the slice-off-the-@ exists at all.
    expect(code).toMatch(/handle\.slice\(1\)/);
    // Negative-with-context: a SEPARATE guard rejects the empty string, not just
    // `handle === undefined`.
    expect(code).toMatch(/username\s*===\s*["']["']/);
  });
});

describe("⚠️ anonymous by construction — the leak defense", () => {
  it("reads exactly the anonymous public profile endpoint", () => {
    // Positive: the page's data source is the anonymous public read, whose api
    // handler (apps/api/src/routes/public.ts handlePublicProfile) reads no
    // session at all.
    expect(code).toContain("apiFetch");
    expect(code).toMatch(/\/public\/profile\?/);
  });

  it("⚠️ forwards NO browser request to the api — nothing to personalize, nothing to leak", () => {
    // If someone adds `request: Astro.request` to "personalize" this page (e.g.
    // an Edit-my-profile banner), its render becomes viewer-specific AND
    // cacheable — a mass session leak — and THIS reddens. (Positive above proved
    // the fetch exists; these negatives are therefore not vacuous.)
    expect(code).not.toContain("Astro.request");
    expect(code).not.toMatch(/\brequest:/);
  });
});

describe("⚠️ keyset pagination — the cursor contract", () => {
  it("reads `?cursor=` off the incoming URL and forwards it opaquely", () => {
    // Positive: the cursor is read from the URL at all.
    expect(code).toMatch(/searchParams\.get\(\s*["']cursor["']\s*\)/);
    // It is handed to a URLSearchParams (auto-encoding), never string-concatenated
    // into the path — the shape that would make a hostile cursor a query-string
    // injection risk instead of a bound param at the api.
    expect(code).toMatch(/URLSearchParams/);
    expect(code).not.toMatch(/cursor=\$\{cursor\}/);
  });

  it("⚠️ a non-200 (draft author's own profile, unknown user, OR the api's 400 on a malformed cursor) collapses to ONE 404, never a 500", () => {
    // Cross-checked against apps/api/test/public-reads.test.ts's
    // "400s a malformed cursor rather than 500ing" — the api already turns
    // `id < 'not-a-uuid'` (a Postgres 22P02) into a 400 INVALID_INPUT, never a
    // crash. This page's job is only to not treat that 400 as anything other
    // than "nothing to render" — the same `status !== 200` branch handles it,
    // an unknown user, AND a network hiccup uniformly.
    expect(code).toMatch(/response\.status\s*!==\s*200/);
    expect(code).toMatch(/status:\s*404/);
  });

  it("exposes the next page via `nextCursor`, never via an offset/page number", () => {
    // Positive proof this is keyset, not offset: the only pagination handle in
    // the page's source is the api's `nextCursor` field.
    expect(code).toMatch(/nextCursor/);
    expect(code).not.toMatch(/\bpage\s*=\s*\d/);
    expect(code).not.toMatch(/\boffset\b/i);
  });
});

describe("cacheability + purge tags", () => {
  it("declares itself public-cacheable via the one helper", () => {
    // Positive presence — the inventory test (page-cache-inventory.test.ts)
    // proves it is the ONLY helper called; this proves it is THIS one (public).
    expect(code).toContain("markPublicCacheable(Astro,");
  });

  it("⚠️ passes exactly the two tags apps/api/src/cache/purge.ts's PUBLISH call site purges by", () => {
    // Cross-checked against apps/api/src/routes/posts.ts:180 —
    //   publish -> purgeTags(env, [`author:${authorId}`, "listing"])
    // (edit additionally purges `post:${id}`, which is irrelevant to a LISTING
    // page: this page never shows one post's full body, so it has no post-scoped
    // tag to carry — but `edit` still purges `author:` + `listing` too, so this
    // page invalidates on edits as well as on publish.)
    // A typo here is invisible locally (miniflare does not simulate Workers
    // Cache); its only symptom is a listing that never reflects a new/edited
    // post for up to 25h. `pipeline:v1` is appended by the helper itself, not here.
    expect(code).toContain("`author:${profile.userId}`");
    expect(code).toMatch(/["']listing["']/);
  });

  it("⚠️ a NOT-FOUND returns BEFORE it ever declares cacheability", () => {
    // So a 404 emits no opt-in and the adapter stamps `no-store` — a not-found is
    // uncached, fail-closed, exactly like [slug].astro's.
    const notFoundAt = code.indexOf("response.status !== 200");
    const cacheAt = code.indexOf("markPublicCacheable(");
    expect(notFoundAt).toBeGreaterThan(-1);
    expect(cacheAt).toBeGreaterThan(-1);
    expect(notFoundAt).toBeLessThan(cacheAt);
  });
});

describe("security headers", () => {
  it("applies the public-page CSP", () => {
    expect(code).toContain("setPublicPageCsp(Astro)");
  });
});

describe("excerpts — never rendered as HTML", () => {
  it("uses markdownExcerpt for the listed posts", () => {
    expect(code).toContain("markdownExcerpt(");
  });

  it("⚠️ never `set:html`s anything — this page renders no markdown body, only escaped text", () => {
    // Positive proved above (markdownExcerpt IS used). Its output is UNESCAPED
    // plain text (packages/markdown/src/excerpt.ts's own header says so); the
    // absence of set:html anywhere on this page means every use is necessarily
    // an Astro `{}` expression, which Astro HTML-escapes on the way out.
    // ⚠️ `code`, not `rawSource` — the page's OWN comments legitimately mention
    // the string "set:html" (to warn against it), and stripComments() removes
    // exactly the `{/* ... */}` Astro-comment form that lives in.
    expect(code).not.toContain("set:html");
  });
});

describe("canonical — a constant origin, never Astro.url", () => {
  it("builds the canonical/OG url from profileUrl, not the request's host", () => {
    expect(code).toContain("profileUrl(");
    // Host is not in the Workers Cache key (src/lib/canonical.ts); a
    // request-derived canonical would be cached under whichever host filled the
    // entry and served under all of them.
    expect(code).not.toMatch(/Astro\.url\.(origin|host)/);
  });
});

describe("no `_`-prefixed or `@`-prefixed segment anywhere under src/pages", () => {
  it("stays out of Astro's silent route-skip trap", () => {
    // Astro's router SILENTLY skips any file OR directory whose name starts with
    // `_` (T14's headline), and a literal `@` directory is the trap `[handle]`
    // avoids. Re-walked here (not just relying on post-page.test.ts) because this
    // file must independently catch a regression even if that other test file is
    // ever deleted.
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
});

/**
 * MANIFEST REACHABILITY — build-gated, same rationale as test/post-page.test.ts.
 */
describe("built route manifest (when dist/ is present)", () => {
  const serverDir = join(import.meta.dirname, "../dist/server");
  const built = existsSync(serverDir);

  it.runIf(built)("contains the /[handle] route", () => {
    const manifest = readdirSync(serverDir)
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => readFileSync(join(serverDir, f), "utf8"))
      .join("\n");
    expect(manifest).toContain('"route":"/[handle]"');
  });

  it.skipIf(built)("SKIPPED: no dist/ — reachability is deploy-gate + report-verified", () => {
    expect(built).toBe(false);
  });
});
