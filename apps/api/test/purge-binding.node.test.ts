import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

/**
 * ⚠️ THE `WEB` SERVICE BINDING MUST BE DECLARED, AND NOTHING ELSE CHECKS THAT.
 *
 * This file exists because of a hole found in review, and the hole is the SAME
 * CLASS as the unroutable route path this task was written to fix: configuration
 * the test suite structurally cannot see, failing silently in production only.
 *
 * `vitest.config.ts` supplies `miniflare.serviceBindings.WEB`, which CREATES the
 * binding for tests REGARDLESS of what wrangler.jsonc says. It has to (miniflare
 * refuses to start with a service binding pointing at a Worker that is not in the
 * pool). But the consequence is brutal and was VERIFIED by deleting the `services`
 * block from wrangler.jsonc:
 *
 *     all 383 api tests -> STILL GREEN
 *     production        -> env.WEB === undefined
 *                       -> TypeError in purgeTags
 *                       -> caught by its own catch (it must never throw)
 *                       -> ONE log line, and EVERY PURGE SILENTLY DEAD FOREVER
 *                       -> every post stale for its full 25h maxAge+swr window
 *
 * The stub proves nothing about the hop — that was always understood. The problem
 * is that it also DISPROVES nothing: it masks the absence of the real config. So
 * the config itself is asserted here, from the real filesystem.
 *
 * ⚠️ WHY THIS IS A `*.node.test.ts`. workerd's filesystem is VIRTUAL (rooted at
 * `/bundle`), so a pool test cannot read this repo's files at all —
 * `readFileSync("wrangler.jsonc")` there fails with
 * `no such file or directory, readAll '/bundle/wrangler.jsonc'` (verified). Config
 * source can only be asserted from the Node project. Mirrors the precedent in
 * apps/web/test/workers-cache.test.ts, which parses wrangler.jsonc the same way.
 */
const API_DIR = join(import.meta.dirname, "..");
const WEB_DIR = join(API_DIR, "../web");

interface WranglerConfig {
  name?: string;
  services?: { binding: string; service: string }[];
}

function readWrangler(dir: string): WranglerConfig {
  return parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as WranglerConfig;
}

const apiConfig = readWrangler(API_DIR);
const webConfig = readWrangler(WEB_DIR);

/**
 * `PURGE_PATH` read out of the SOURCE TEXT rather than imported. The module types
 * `env: Env`, a global that only exists in the workerd scope — importing it here
 * (Node, `types: ["node"]`) would not type-check. Reading the source is the same
 * technique apps/web/test/workers-cache.test.ts uses on the adapter.
 */
function purgePathFromSource(): string {
  const source = readFileSync(join(API_DIR, "src/cache/purge.ts"), "utf8");
  const match = /const PURGE_PATH = "([^"]+)"/.exec(source);
  if (match === null) {
    throw new Error("PURGE_PATH not found in src/cache/purge.ts — has it been renamed?");
  }
  return match[1]!;
}

describe("⚠️ the WEB service binding is DECLARED (not just stubbed in tests)", () => {
  it("wrangler.jsonc declares the WEB binding to the web Worker", () => {
    // ⚠️ MUTATION-TESTED: deleting the `services` block from wrangler.jsonc
    // reddens THIS test and nothing else in the suite. That is the whole point.
    expect(
      apiConfig.services,
      "apps/api/wrangler.jsonc has no `services` block. Without it `env.WEB` is undefined in production, purgeTags catches the TypeError, and EVERY purge dies silently — the tests cannot see this because vitest.config.ts stubs the binding.",
    ).toBeDefined();
    expect(apiConfig.services).toContainEqual({
      binding: "WEB",
      service: "thinkersjournal-web",
    });
  });

  it("the bound service NAMES the web Worker's actual wrangler `name`", () => {
    // A Service Binding resolves by NAME at deploy. Renaming the web Worker
    // without updating this would fail only at `wrangler deploy` — or, worse,
    // bind to nothing. Cross-config agreement, asserted from both files.
    const web = apiConfig.services?.find((s) => s.binding === "WEB");
    expect(web?.service).toBe(webConfig.name);
  });
});

describe("⚠️ PURGE_PATH names a route web ACTUALLY serves", () => {
  it("resolves to a real file under apps/web/src/pages", () => {
    // ⚠️ THE CROSS-HALF CONTRACT. api dispatches to PURGE_PATH; web serves it from
    // a file-based route. Nothing else in either package ties those two together —
    // apps/web's tests cannot see api's constant, and api's pool tests cannot see
    // web's filesystem.
    const routeFile = join(WEB_DIR, "src/pages", `${purgePathFromSource()}.ts`);
    expect(
      existsSync(routeFile),
      `apps/api/src/cache/purge.ts dispatches to "${purgePathFromSource()}", but ${routeFile} does not exist. The two halves of the purge hop disagree; api would POST into a 404 and every purge would silently fail.`,
    ).toBe(true);
  });

  it("has NO underscore-prefixed segment, which Astro would silently drop", () => {
    // ⚠️ THIS IS THE BUG THIS TASK ALREADY HIT ONCE. The plan specified
    // `/__internal/purge`; Astro's router SKIPS any file or directory whose name
    // starts with `_` (astro@7.0.9 dist/core/routing/create-manifest.js:
    // `if (name[0] === "_") { continue; }`), so the route never entered the build
    // manifest and every request 404'd — with no warning, while every unit test
    // stayed green. Asserted here on the REAL path, derived from the source.
    for (const segment of purgePathFromSource().split("/").filter(Boolean)) {
      expect(
        segment.startsWith("_"),
        `PURGE_PATH segment "${segment}" starts with "_", so Astro's router skips it and the route 404s with no warning anywhere.`,
      ).toBe(false);
    }
  });
});
