import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { parseArgs } from "../scripts/lib/migrate-args.mjs";

/**
 * `apps/api/scripts/migrate.mjs`'s argument parsing (#116 fix round 1, item
 * 4) — the optional 3rd `count` argument that caps how many pending
 * migrations `up` applies, so the deploy runbook can apply migrations one at
 * a time and stop before one marked `-- deploy: after-code`.
 *
 * ⚠️ WHY THE LIBRARY SPLIT (fix round 2 ruling). Fix round 1 guarded
 * `migrate.mjs`'s real work (`runner(...)`, which opens a database
 * connection) behind `import.meta.url === pathToFileURL(process.argv[1])
 * .href`, purely so `parseArgs` could be imported and tested without
 * touching a database. The controller found that comparison can FAIL OPEN —
 * a symlinked path in the environment, or a Windows drive-letter/case
 * mismatch, makes it wrongly `false` — and for this script that means the
 * PM's "apply the migration" run would silently do nothing and report
 * nothing. The fix: `parseArgs` now lives in
 * `apps/api/scripts/lib/migrate-args.mjs`, which has NO side effects
 * whatsoever (no `node-pg-migrate` import, no database, no filesystem), so
 * importing it for testing can never run a migration — and `migrate.mjs`
 * itself needs no conditional and runs unconditionally, exactly as it did
 * before round 1.
 */

describe("parseArgs", () => {
  it("defaults to target=dev, direction=up, count=Infinity with no args", () => {
    expect(parseArgs([])).toEqual({ target: "dev", direction: "up", count: Infinity });
  });

  it("defaults count to 1 for direction=down", () => {
    expect(parseArgs(["dev", "down"])).toEqual({ target: "dev", direction: "down", count: 1 });
  });

  it("honors an explicit target and direction", () => {
    expect(parseArgs(["test", "up"])).toEqual({ target: "test", direction: "up", count: Infinity });
  });

  it("an explicit count overrides the up default", () => {
    expect(parseArgs(["dev", "up", "1"])).toEqual({ target: "dev", direction: "up", count: 1 });
  });

  it("an explicit count overrides the down default too", () => {
    expect(parseArgs(["dev", "down", "3"])).toEqual({ target: "dev", direction: "down", count: 3 });
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["a non-integer", "1.5"],
    ["not a number at all", "abc"],
    ["empty string", ""],
  ])("rejects a %s count with a clear error", (_label, value) => {
    expect(() => parseArgs(["dev", "up", value])).toThrow(/count must be a positive integer/);
  });
});

describe("fix round 2, item 3: importing the LIBRARY has no side effects", () => {
  it("stubbing fetch and importing scripts/lib/migrate-args.mjs calls no fetch and sets no process.exitCode", async () => {
    // `fetch` is not logically relevant to this library (it never calls it),
    // but the stub-and-assert shape is kept identical to the gate's own lib
    // test (scripts/lib/migration-gate.mjs) deliberately — the property
    // being proven is the same: importing a pure library runs nothing.
    const originalFetch = globalThis.fetch;
    const originalExitCode = process.exitCode;
    const fetchSpy = vi.fn(() => {
      throw new Error("fetch must not be called merely by importing the library");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    process.exitCode = undefined;

    try {
      const bust = `${Date.now()}-${Math.random()}`;
      const libUrl = pathToFileURL(join(import.meta.dirname, "..", "scripts", "lib", "migrate-args.mjs")).href;
      await import(/* @vite-ignore */ `${libUrl}?bust=${bust}`);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      process.exitCode = originalExitCode;
    }
  });
});

describe("fix round 2, item 3: migrate.mjs has no entry-point guard (source-level pin)", () => {
  // Source-level pin, same technique as apps/web/test/db-health-proxy.test.ts —
  // reads the file as TEXT rather than importing it, since importing the CLI
  // module runs the real migration unconditionally (by design: see its
  // header). NEVER import apps/api/scripts/migrate.mjs from a test.
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  const CLI_PATH = join(import.meta.dirname, "..", "scripts", "migrate.mjs");
  const code = stripComments(readFileSync(CLI_PATH, "utf8"));

  it("has no conditional of any kind — this file's real body has no legitimate `if` either, so ANY `if (` means a guard crept back in", () => {
    expect(code).not.toMatch(/if\s*\(/);
  });

  it("round 1's guard condition (pathToFileURL(process.argv[1])) does not reappear", () => {
    expect(code).not.toMatch(/pathToFileURL\s*\(\s*process\.argv\[1\]\s*\)/);
  });

  it("calls `await runner(` unconditionally, as the last statement in the file", () => {
    expect(code.trimEnd().endsWith("});")).toBe(true);
    expect(code).toContain("await runner({");
  });
});
