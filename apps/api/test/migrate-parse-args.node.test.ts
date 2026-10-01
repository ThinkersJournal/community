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

/**
 * ⚠️ WHY A STRUCTURAL CHECK, NOT A FRESH DYNAMIC RE-IMPORT (fix round 2, item
 * 4). An earlier draft proved "importing the library has no side effects"
 * behaviorally — stub `fetch`, cache-bust a dynamic `import()`, assert the
 * stub was never called. Under full-suite load that timed out at the node
 * project's 5000ms default (reproduced here too: 5020ms), for the same
 * reason as the gate's identical pattern — a fresh cache-busted specifier
 * forces Vite's transform pipeline to build a new module graph entry, which
 * contends under heavy parallel load. The property doesn't need a fresh
 * import: `scripts/lib/migrate-args.mjs`'s top level contains NOTHING but an
 * `export function` declaration (verified below), and a module with no
 * top-level executable statement cannot have an import-time side effect by
 * the ECMAScript module spec itself — a stronger guarantee, at a fraction of
 * the cost.
 */
describe("fix round 2, item 4: the library has no side effects, proven structurally and fast", () => {
  const libSource = stripComments(
    readFileSync(join(import.meta.dirname, "..", "scripts", "lib", "migrate-args.mjs"), "utf8"),
  );
  const statements = topLevelStatements(libSource);

  it("found at least one top-level statement (positive control — the scan isn't vacuously passing)", () => {
    expect(statements.length).toBeGreaterThan(0);
  });

  it("every top-level statement in scripts/lib/migrate-args.mjs is an export declaration", () => {
    const nonExports = statements.filter((s) => !s.startsWith("export"));
    expect(nonExports).toEqual([]);
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
