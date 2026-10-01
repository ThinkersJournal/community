import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArgs } from "../scripts/lib/migrate-args.mjs";

/** Shared by both source-level checks below. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Splits `source` into its top-level statements by brace depth. See the
 * identical helper (and its full reasoning) in
 * apps/api/test/check-migrations-applied.node.test.ts — kept as a separate
 * small copy here rather than a shared test-helper module, consistent with
 * this repo's existing per-file `stripComments` duplication convention (e.g.
 * apps/web/test/db-health-proxy.test.ts vs. health-schema-proxy.test.ts).
 */
function topLevelStatements(source: string): string[] {
  const statements: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of source) {
    current += ch;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0 && (ch === ";" || ch === "}")) {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
    }
  }
  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

/**
 * A top-level statement cannot have an import-time side effect iff it is
 * EITHER an `export (async )?function ...` (defining has no effect; calling
 * would, but nothing here does that at the top level), or an `export
 * const|let NAME = <initializer>;` whose initializer contains no call
 * expression (an identifier directly followed by `(`) — `export const x =
 * sideEffect();` DOES run at import time and must be rejected, which a bare
 * "starts with export" check would miss. See the identical helper (and its
 * full false-positive caveat) in
 * apps/api/test/check-migrations-applied.node.test.ts.
 */
function isSafeTopLevelStatement(statement: string): boolean {
  if (/^export\s+(?:async\s+)?function\b/.test(statement)) return true;

  const constOrLet = /^export\s+(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*([\s\S]*);$/.exec(statement);
  if (constOrLet) {
    const initializer = constOrLet[1];
    return !/[A-Za-z_$][\w$]*\s*\(/.test(initializer);
  }

  return false;
}

/**
 * `apps/api/scripts/migrate.mjs`'s argument parsing (#116 fix round 1, item
 * 4) — the optional 3rd `count` argument that caps how many pending
 * migrations `up` applies, so the deploy runbook can apply migrations one at
 * a time and stop before one marked `-- deploy: after-code`.
 *
 * ⚠️ WHY THE LIBRARY SPLIT — see scripts/lib/migration-gate.mjs's header for
 * the full fail-open story (fix round 2 ruling); the same risk applied here
 * to `migrate.mjs`'s `runner(...)` call (which opens a database connection).
 * `parseArgs` now lives in `apps/api/scripts/lib/migrate-args.mjs`, which has
 * no side effects whatsoever.
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

/**
 * ⚠️ WHY A STRUCTURAL CHECK, NOT A FRESH DYNAMIC RE-IMPORT (fix round 2, item
 * 4). An earlier draft stubbed `fetch`, cache-busted a dynamic `import()`,
 * and asserted it was never called — timed out under full-suite load at the
 * node project's 5000ms default (reproduced: 5020ms), same reason as the
 * gate's identical pattern (see that test file for the full explanation).
 * Checking that every top-level statement is a side-effect-free export
 * (below) proves the same thing statically, in microseconds.
 */
describe("fix round 2, item 4: the library has no side effects, proven structurally and fast", () => {
  const libSource = stripComments(
    readFileSync(join(import.meta.dirname, "..", "scripts", "lib", "migrate-args.mjs"), "utf8"),
  );
  const statements = topLevelStatements(libSource);

  it("found at least one top-level statement (positive control — the scan isn't vacuously passing)", () => {
    expect(statements.length).toBeGreaterThan(0);
  });

  it("every top-level statement in scripts/lib/migrate-args.mjs is a side-effect-free export", () => {
    const unsafe = statements.filter((s) => !isSafeTopLevelStatement(s));
    expect(unsafe).toEqual([]);
  });
});

describe("fix round 2, item 3: migrate.mjs has no entry-point guard (source-level pin)", () => {
  // Source-level pin, same technique as apps/web/test/db-health-proxy.test.ts —
  // reads the file as TEXT rather than importing it, since importing the CLI
  // module runs the real migration unconditionally (by design: see its
  // header). NEVER import apps/api/scripts/migrate.mjs from a test.
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
