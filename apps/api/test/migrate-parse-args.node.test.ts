import { describe, expect, it } from "vitest";

import { parseArgs } from "../scripts/migrate.mjs";

/**
 * `apps/api/scripts/migrate.mjs`'s argument parsing (#116 fix round 1, item
 * 4) — the optional 3rd `count` argument that caps how many pending
 * migrations `up` applies, so the deploy runbook can apply migrations one at
 * a time and stop before one marked `-- deploy: after-code`.
 *
 * ⚠️ NEVER EXECUTES A MIGRATION. `parseArgs` is pure (no `node-pg-migrate`
 * import, no database connection); `migrate.mjs`'s real work is guarded
 * behind an entry-point check (same pattern as
 * scripts/check-migrations-applied.mjs), so importing this module for
 * `parseArgs` alone never calls `runner(...)`. Confirmed below.
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

describe("importing migrate.mjs never executes a migration", () => {
  it("the static `import { parseArgs }` above set no process.exitCode and threw nothing", () => {
    // This test file's own top-level `import { parseArgs } from
    // "../scripts/migrate.mjs"` already ran, under THIS process's real
    // `process.argv` (vitest's own CLI invocation, not
    // `node scripts/migrate.mjs ...`) — exactly the entry-point guard's
    // condition (`import.meta.url === pathToFileURL(process.argv[1]).href`)
    // correctly evaluating false in a test context. If the guard were absent
    // or broken, `main()` would have run on import and attempted a REAL
    // database connection via `node-pg-migrate`'s `runner`, which would have
    // thrown (or hung) well before this test file's first `it` ran at all.
    // Reaching this assertion at all is the proof.
    expect(process.exitCode).toBeUndefined();
  });
});
