import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared "is this route in the BUILT server manifest" lookup, used by every
 * `describe("built route manifest (when dist/ is present)", ...)` block.
 *
 * ⚠️ WHY A SHARED HELPER, AND WHY IT WALKS THE WHOLE TREE. Through
 * astro@7.2.8 / @astrojs/cloudflare@14.1.3 the route manifest lived entirely
 * in `dist/server/entry.mjs`, so every one of these test files grepped that
 * one file directly. astro@7.3.5 / @astrojs/cloudflare@14.3.3 moved it into a
 * content-hashed chunk under `dist/server/chunks/` (e.g.
 * `entrypoints_<hash>.mjs`) instead — `entry.mjs` itself now contains none of
 * it. Six files duplicated the same now-wrong lookup, so it is fixed once,
 * here, by reading every `.mjs` file under `dist/server` recursively rather
 * than guessing a filename that can change again on the next bundler bump.
 */
const SERVER_DIR = join(import.meta.dirname, "../../dist/server");

/** True only when `pnpm --filter @thinkersjournal/web build` has already run. */
export const serverBuilt = existsSync(SERVER_DIR);

function allMjsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return allMjsFiles(full);
    return entry.name.endsWith(".mjs") ? [full] : [];
  });
}

/**
 * The concatenated text of every `.mjs` file under `dist/server`, recursed
 * into subdirectories (`chunks/` included). Callers grep this for
 * `"route":"/whatever"` the same way they grepped `entry.mjs` before.
 *
 * ⚠️ POSITIVE CONTROL: throws loudly if `dist/server` exists but nothing
 * under it contains a `"routeData":` marker at all. Without this, a future
 * relocation (or a build that silently produced an empty/wrong tree) would
 * make every caller's `.not.toContain(...)` assertion pass VACUOUSLY and every
 * `.toContain(...)` assertion fail with a confusing message pointing at the
 * wrong route instead of the real cause. Callers must only call this behind
 * `serverBuilt` (same guard `existsSync(SERVER_ENTRY)` used before).
 */
export function readRouteManifest(): string {
  if (!serverBuilt) {
    throw new Error(
      `${SERVER_DIR} does not exist — call readRouteManifest() only when \`serverBuilt\` is true.`,
    );
  }
  const files = allMjsFiles(SERVER_DIR);
  const manifest = files.map((f) => readFileSync(f, "utf8")).join("\n");
  if (!manifest.includes('"routeData":')) {
    throw new Error(
      `Found ${files.length} .mjs file(s) under ${SERVER_DIR} but none contain a "routeData": ` +
        "marker — the route manifest moved or the build output's shape changed again. " +
        "Update this helper (not the tests that call it) before trusting any route check here.",
    );
  }
  return manifest;
}
