import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  evaluate,
  findDisallowedMigrationFiles,
  pickGateMigration,
} from "../../../scripts/check-migrations-applied.mjs";

/**
 * The deploy-time migration gate (#116, shape A) — `scripts/check-migrations-
 * applied.mjs` itself. Covers the pieces exported pure so they're testable
 * without the network or a real migrations directory: `pickGateMigration`
 * (which file it gates on), `findDisallowedMigrationFiles` (fix round 1, item
 * 7), and `evaluate` (pass/fail on a fetch outcome). Also covers fix round
 * 1's item 1 (the import-must-not-run-the-gate guard) and item 5's
 * filename-shape positive control against the real migrations directory.
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
  it("apps/api/migrations/*.sql all match /^\\d{4}_[a-z0-9_]{1,100}\\.sql$/ (positive control: at least 19 files read)", () => {
    const dir = join(import.meta.dirname, "..", "migrations");
    const sqlFiles = readdirSync(dir).filter((f) => f.endsWith(".sql"));

    // Positive control: this must actually be reading real files, not an
    // empty/wrong directory silently passing vacuously.
    expect(sqlFiles.length).toBeGreaterThanOrEqual(19);

    const pattern = /^\d{4}_[a-z0-9_]{1,100}\.sql$/;
    const offenders = sqlFiles.filter((f) => !pattern.test(f));
    expect(offenders).toEqual([]);
  });
});

describe("fix round 1, item 1: import must not run the gate", () => {
  it("importing the module calls no fetch and sets no process.exitCode", async () => {
    const originalFetch = globalThis.fetch;
    const originalExitCode = process.exitCode;
    const fetchSpy = vi.fn(() => {
      throw new Error("fetch must not be called by a bare import");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    process.exitCode = undefined;

    try {
      // Cache-busting query string: without it, Node/Vitest's module cache
      // would hand back the ALREADY-IMPORTED instance from the describe
      // blocks above (whose top-level guard already ran once, proving
      // nothing about whether a FRESH import would re-run it).
      const bust = `${Date.now()}-${Math.random()}`;
      const scriptUrl = pathToFileURL(
        join(import.meta.dirname, "..", "..", "..", "scripts", "check-migrations-applied.mjs"),
      ).href;
      await import(/* @vite-ignore */ `${scriptUrl}?bust=${bust}`);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      process.exitCode = originalExitCode;
    }
  });
});
