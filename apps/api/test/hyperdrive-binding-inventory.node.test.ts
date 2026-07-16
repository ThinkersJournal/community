import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ⚠️ THE `HYPERDRIVE_CACHED` INVENTORY.
 *
 * src/db/client.ts's header states the rule in prose: `HYPERDRIVE_FRESH` for
 * every auth/session/permission/dup-email/verify/read-after-write query,
 * `HYPERDRIVE_CACHED` ONLY for a read whose edge entry is not purge-invalidated.
 * That held by CONVENTION through Task 9, which found `/public/recent`
 * defensible for CACHED "in isolation" but kept it FRESH anyway — the
 * compensating edge TTL (T12/T13) did not exist yet, so a CACHED read there
 * would have been a stale read with nothing in front of it. Task 18 built that
 * TTL (`sitemap.xml`/`rss.xml`, apps/web/src/lib/cache.ts's
 * `markFeedCacheable`) and made the deferred call: `handlePublicRecent`
 * (src/routes/public.ts) now reads through `HYPERDRIVE_CACHED`.
 *
 * The M1 plan's deploy-gate item said this should be checkable by hand
 * (`rg -n 'HYPERDRIVE_CACHED' apps/api/src` -> exactly one hit, in
 * src/routes/public.ts). This file mechanizes that — with one necessary
 * correction: a raw grep also matches PROSE that merely mentions the
 * identifier (src/db/client.ts's rule statement, this file's own header, the
 * generated worker-configuration.d.ts binding declaration) and would
 * over-count something that was never a second call site. Comments are
 * stripped first (same technique as
 * apps/web/test/page-cache-inventory.test.ts's stripComments) so only a REAL
 * `env.HYPERDRIVE_CACHED` reference counts, and the generated types file
 * (wrangler.jsonc's own header says "run 'wrangler types' ... and commit the
 * regenerated file") is excluded for the same reason SWEEP A/B exclude
 * src/lib/cache.ts from itself: it is not application code making a choice.
 *
 * ⚠️ WHY A `.node.test.ts`. workerd's filesystem is virtual (rooted at
 * `/bundle`), so a pool test cannot read this repo's own files at all — see
 * test/purge-binding.node.test.ts's header for the verified error. Source text
 * can only be asserted from the Node project (vitest.config.ts).
 */
const SRC_DIR = join(import.meta.dirname, "../src");
const GENERATED_FILES: ReadonlySet<string> = new Set(["worker-configuration.d.ts"]);

/** Every `.ts` file under `dir`, recursively. */
function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

/** Path relative to `src/`, forward slashes, for stable assertions/messages. */
function rel(file: string): string {
  return file.replace(/\\/g, "/").split("src/")[1] ?? file;
}

/**
 * Strip comments so a mention IN PROSE cannot count as a real usage. Same
 * technique as apps/web/test/page-cache-inventory.test.ts's stripComments.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SOURCE_FILES = allFiles(SRC_DIR).filter(
  (f) => extname(f) === ".ts" && !GENERATED_FILES.has(rel(f).split("/").pop() ?? ""),
);

describe("⚠️ HYPERDRIVE_CACHED is used in exactly one real place", () => {
  it("found source files to check (tripwire — a moved src/ would pass vacuously)", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(3);
  });

  it("appears in LIVE code exactly once across apps/api/src, in src/routes/public.ts", () => {
    const hits: string[] = [];
    for (const file of SOURCE_FILES) {
      const source = stripComments(readFileSync(file, "utf8"));
      const count = (source.match(/HYPERDRIVE_CACHED/g) ?? []).length;
      for (let i = 0; i < count; i++) hits.push(rel(file));
    }
    expect(
      hits,
      `HYPERDRIVE_CACHED must be used in EXACTLY ONE place: GET /public/recent (src/routes/public.ts) — the only read sitemap.xml/rss.xml consume, whose edge entry is untagged and short-TTL. Found ${hits.length} live use(s): ${hits.join(", ") || "(none)"}. If you meant to add a new CACHED read, re-read src/routes/public.ts's file header first — a read backing a purge-tagged page can serve a pre-edit row that the edge then re-caches for up to 25h.`,
    ).toEqual(["routes/public.ts"]);
  });

  it("that one use lives inside handlePublicRecent, not another handler in the same file", () => {
    const source = stripComments(readFileSync(join(SRC_DIR, "routes/public.ts"), "utf8"));
    const fnStart = source.indexOf("export async function handlePublicRecent");
    expect(
      fnStart,
      "handlePublicRecent not found in src/routes/public.ts (by this exact name) — has it been renamed? Update this test's anchor.",
    ).toBeGreaterThan(-1);

    // Nothing BEFORE handlePublicRecent (handlePublicPost, handlePublicProfile)
    // may reference it...
    expect(source.slice(0, fnStart)).not.toContain("HYPERDRIVE_CACHED");
    // ...and the reference must actually be inside it, not merely somewhere
    // later in the file after an early return.
    expect(source.slice(fnStart)).toContain("HYPERDRIVE_CACHED");
  });

  it("every OTHER route in src/routes/public.ts still uses HYPERDRIVE_FRESH", () => {
    const source = stripComments(readFileSync(join(SRC_DIR, "routes/public.ts"), "utf8"));
    for (const handler of ["handlePublicPost", "handlePublicProfile"]) {
      const fnStart = source.indexOf(`export async function ${handler}`);
      expect(fnStart, `${handler} not found in src/routes/public.ts — has it been renamed?`).toBeGreaterThan(-1);
      const nextFnStart = source.indexOf("export async function", fnStart + 1);
      const fnBody = nextFnStart === -1 ? source.slice(fnStart) : source.slice(fnStart, nextFnStart);
      expect(fnBody, `${handler} no longer reads via HYPERDRIVE_FRESH.`).toContain("HYPERDRIVE_FRESH");
      expect(fnBody, `${handler} must never read via HYPERDRIVE_CACHED — see the file header.`).not.toContain(
        "HYPERDRIVE_CACHED",
      );
    }
  });
});
