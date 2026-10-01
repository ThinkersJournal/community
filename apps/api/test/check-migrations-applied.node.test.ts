import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  MIGRATION_NAME_RE,
  evaluate,
  findDisallowedMigrationFiles,
  pickGateMigration,
} from "../../../scripts/lib/migration-gate.mjs";

/**
 * The deploy-time migration gate (#116, shape A). Covers the PURE library
 * (`scripts/lib/migration-gate.mjs`) and, separately, a source-level pin on
 * the CLI (`scripts/check-migrations-applied.mjs`) that it still has no
 * entry-point guard.
 *
 * ⚠️ WHY THE LIBRARY SPLIT (fix round 2 ruling). Fix round 1 guarded the
 * CLI's `await main()` with `import.meta.url === pathToFileURL(
 * process.argv[1]).href`, specifically so this test file could import the
 * CLI directly for its pure exports without also fetching production. The
 * controller found that guard can FAIL OPEN (a symlinked path, or a Windows
 * drive-letter/case mismatch, makes the comparison wrongly `false`) — for
 * this script that means a deploy passes UNCHECKED, the one failure it must
 * never have. The fix is structural: every pure function now lives in
 * `scripts/lib/migration-gate.mjs`, which has no top-level side effects at
 * all, so this file imports ONLY that library — never the CLI — and the CLI
 * itself needs no conditional to protect, because nothing imports it for
 * testing anymore. The CLI's unconditional `await main();` is pinned at the
 * source level below, so a guard like round 1's cannot be reintroduced
 * silently.
 *
 * ⚠️ WHY THIS IS A `*.node.test.ts`, NOT A POOL TEST. The script itself runs
 * under plain Node (it is invoked directly by Cloudflare Workers Builds, never
 * bundled into a Worker), has no `Env`/Hyperdrive dependency, and does real
 * `node:fs` reads in its non-pure half — workerd's virtual filesystem cannot
 * run it at all, same reasoning as apps/api/test/purge-binding.node.test.ts.
 */

describe("pickGateMigration", () => {
  it("picks the newest *.sql file when none are marked after-code", () => {
    const entries = ["0002_posts.sql", "0001_users.sql", "0003_tags.sql"];
    const readHead = () => ["-- Up Migration", "--"];

    expect(pickGateMigration(entries, readHead)).toEqual({ name: "0003_tags", reason: null });
  });

  it("ignores non-.sql entries in the directory listing", () => {
    const entries = ["0001_users.sql", "README.md", ".gitkeep"];
    const readHead = () => ["-- Up Migration"];

    expect(pickGateMigration(entries, readHead)).toEqual({ name: "0001_users", reason: null });
  });

  it("skips a newest file marked `-- deploy: after-code` and gates on the one before it", () => {
    const entries = ["0001_users.sql", "0002_posts.sql", "0003_drop_old_col.sql"];
    const readHead = (name: string) =>
      name === "0003_drop_old_col.sql"
        ? ["-- Up Migration", "--", "-- deploy: after-code", "--"]
        : ["-- Up Migration", "--"];

    expect(pickGateMigration(entries, readHead)).toEqual({ name: "0002_posts", reason: null });
  });

  it("keeps skipping through MULTIPLE trailing after-code migrations", () => {
    const entries = ["0001_users.sql", "0002_posts.sql", "0003_drop_a.sql", "0004_drop_b.sql"];
    const afterCode = new Set(["0003_drop_a.sql", "0004_drop_b.sql"]);
    const readHead = (name: string) =>
      afterCode.has(name) ? ["-- deploy: after-code"] : ["-- Up Migration"];

    expect(pickGateMigration(entries, readHead)).toEqual({ name: "0002_posts", reason: null });
  });

  it("only looks at the marker within the first 20 lines", () => {
    // The marker appears, but past the 20-line window `readHead` represents —
    // a real readHead never hands back more than that, so this simulates a
    // migration whose marker (if any) is further down and therefore NOT seen.
    const entries = ["0001_users.sql", "0002_late_marker.sql"];
    const readHead = (name: string) =>
      name === "0002_late_marker.sql"
        ? Array.from({ length: 20 }, (_, i) => `-- line ${i}`)
        : ["-- Up Migration"];

    expect(pickGateMigration(entries, readHead)).toEqual({
      name: "0002_late_marker",
      reason: null,
    });
  });

  it("returns reason:all-after-code when every migration present is marked after-code", () => {
    const entries = ["0001_drop_a.sql"];
    const readHead = () => ["-- deploy: after-code"];

    expect(pickGateMigration(entries, readHead)).toEqual({
      name: null,
      reason: "all-after-code",
    });
  });

  it("fix round 1 item 6: returns reason:no-sql-files for a directory with zero .sql entries (a broken checkout)", () => {
    const entries = ["README.md", ".gitkeep"];
    const readHead = () => {
      throw new Error("must not be called — there is nothing to read a head from");
    };

    expect(pickGateMigration(entries, readHead)).toEqual({
      name: null,
      reason: "no-sql-files",
    });
  });

  it("fix round 1 item 6: distinguishes no-sql-files from all-after-code (different reasons)", () => {
    const empty = pickGateMigration([], () => []);
    const allAfterCode = pickGateMigration(["0001_a.sql"], () => ["-- deploy: after-code"]);

    expect(empty.reason).toBe("no-sql-files");
    expect(allAfterCode.reason).toBe("all-after-code");
    expect(empty.reason).not.toBe(allAfterCode.reason);
  });
});

describe("findDisallowedMigrationFiles (fix round 1, item 7)", () => {
  it("returns [] when every entry is .sql or otherwise harmless", () => {
    const entries = ["0001_users.sql", "0002_posts.sql", "README.md", ".gitkeep"];

    expect(findDisallowedMigrationFiles(entries)).toEqual([]);
  });

  it.each([
    ["a .js migration", "0003_backfill.js"],
    ["a .cjs migration", "0003_backfill.cjs"],
    ["a .mjs migration", "0003_backfill.mjs"],
    ["a .ts migration", "0003_backfill.ts"],
  ])("flags %s as disallowed", (_label, name) => {
    expect(findDisallowedMigrationFiles(["0001_users.sql", name])).toEqual([name]);
  });

  it("flags multiple disallowed files, sorted", () => {
    const entries = ["0001_users.sql", "0003_z.ts", "0002_a.js"];

    expect(findDisallowedMigrationFiles(entries)).toEqual(["0002_a.js", "0003_z.ts"]);
  });
});

describe("evaluate", () => {
  it("passes on HTTP 200 with {applied:true}", async () => {
    const response = new Response(JSON.stringify({ applied: true }), { status: 200 });
    const result = await evaluate(Promise.resolve(response));

    expect(result.pass).toBe(true);
  });

  it("fails on HTTP 200 with {applied:false}", async () => {
    const response = new Response(JSON.stringify({ applied: false }), { status: 200 });
    const result = await evaluate(Promise.resolve(response));

    expect(result.pass).toBe(false);
  });

  it("fails on a 503", async () => {
    const response = new Response(JSON.stringify({ applied: null }), { status: 503 });
    const result = await evaluate(Promise.resolve(response));

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("503");
  });

  it("fails on a non-JSON body", async () => {
    const response = new Response("not json", { status: 200 });
    const result = await evaluate(Promise.resolve(response));

    expect(result.pass).toBe(false);
  });

  it("fails on a thrown fetch (network error / our own abort timeout / a refused redirect)", async () => {
    const result = await evaluate(Promise.reject(new Error("fetch failed")));

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("fetch failed");
  });
});

describe("fix round 1, item 5: every real migration file name matches the api's accepted pattern", () => {
  it("apps/api/migrations/*.sql all match MIGRATION_NAME_RE + .sql (positive control: at least 19 files read)", () => {
    const dir = join(import.meta.dirname, "..", "migrations");
    const sqlFiles = readdirSync(dir).filter((f) => f.endsWith(".sql"));

    // Positive control: this must actually be reading real files, not an
    // empty/wrong directory silently passing vacuously.
    expect(sqlFiles.length).toBeGreaterThanOrEqual(19);

    const offenders = sqlFiles.filter((f) => !MIGRATION_NAME_RE.test(f.replace(/\.sql$/, "")));
    expect(offenders).toEqual([]);
  });
});

describe("fix round 2, item 3: importing the LIBRARY has no side effects", () => {
  it("stubbing fetch and importing scripts/lib/migration-gate.mjs calls no fetch and sets no process.exitCode", async () => {
    const originalFetch = globalThis.fetch;
    const originalExitCode = process.exitCode;
    const fetchSpy = vi.fn(() => {
      throw new Error("fetch must not be called merely by importing the library");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    process.exitCode = undefined;

    try {
      // Cache-busting query string: without it, Node/Vitest's module cache
      // would hand back the ALREADY-IMPORTED instance from the describe
      // blocks above, proving nothing about a FRESH import.
      const bust = `${Date.now()}-${Math.random()}`;
      const libUrl = pathToFileURL(
        join(import.meta.dirname, "..", "..", "..", "scripts", "lib", "migration-gate.mjs"),
      ).href;
      await import(/* @vite-ignore */ `${libUrl}?bust=${bust}`);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      process.exitCode = originalExitCode;
    }
  });
});

describe("fix round 2, item 3: the CLI has no entry-point guard (source-level pin)", () => {
  // Source-level pin, same technique as apps/web/test/db-health-proxy.test.ts —
  // reads the file as TEXT rather than importing it, since importing the CLI
  // module runs `main()` for real (unconditionally, by design: see its header).
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  const CLI_PATH = join(import.meta.dirname, "..", "..", "..", "scripts", "check-migrations-applied.mjs");
  const code = stripComments(readFileSync(CLI_PATH, "utf8"));

  it("calls `await main();` as the LAST statement in the file, unconditionally", () => {
    // If a guard like round 1's were reintroduced (`if (...) { await
    // main(); }`), the file's last non-comment statement would be a closing
    // `}`, not a bare `await main();` — this fails exactly that case.
    expect(code.trimEnd().endsWith("await main();")).toBe(true);
  });

  it("round 1's guard condition (pathToFileURL(process.argv[1])) does not reappear", () => {
    expect(code).not.toMatch(/pathToFileURL\s*\(\s*process\.argv\[1\]\s*\)/);
  });
});
