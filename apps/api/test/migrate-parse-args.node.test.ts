import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeTarget, parseArgs, resolveTarget } from "../scripts/lib/migrate-args.mjs";

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

/**
 * 2026-10-17 hardening: `migrate.mjs` used to default SILENTLY to the localhost dev
 * database when `DATABASE_URL` was unset, so a production URL under another variable
 * name migrated the LOCAL database with no signal. `resolveTarget` is pure (the
 * environment is an argument), so every branch is tested here.
 */
describe("resolveTarget: no silent default, no silent remote, always a banner", () => {
  const PROD = "postgres://app_owner:s3cret-pw@db.example.neon.tech:5432/prod_db?sslmode=require";
  const LOCAL = "postgres://postgres:postgres@localhost:5432/thinkersjournal";

  it("dev with DATABASE_URL unset and no --local THROWS (the incident)", () => {
    expect(() => resolveTarget(["dev", "up"], {})).toThrow(/DATABASE_URL is not set/);
  });

  it("an empty DATABASE_URL counts as unset", () => {
    expect(() => resolveTarget(["dev", "up"], { DATABASE_URL: "" })).toThrow(/DATABASE_URL is not set/);
  });

  it("the same unset environment with --local resolves to the localhost default and says so", () => {
    const t = resolveTarget(["dev", "up", "--local"], {});
    expect(t.host).toBe("localhost");
    expect(t.database).toBe("thinkersjournal");
    expect(t.banner).toContain("localhost:5432/thinkersjournal");
    expect(t.banner).toContain("built-in localhost default");
  });

  it("a localhost DATABASE_URL needs no flag", () => {
    const t = resolveTarget(["dev", "up"], { DATABASE_URL: LOCAL });
    expect(t.databaseUrl).toBe(LOCAL);
    expect(t.banner).toContain("from DATABASE_URL");
  });

  it("loopback addresses count as local", () => {
    for (const host of ["127.0.0.1", "[::1]", "LOCALHOST"]) {
      expect(() => resolveTarget(["dev", "up"], { DATABASE_URL: `postgres://u:p@${host}:5432/d` })).not.toThrow();
    }
  });

  it("a remote host WITHOUT --allow-remote THROWS and names the host", () => {
    expect(() => resolveTarget(["dev", "up"], { DATABASE_URL: PROD })).toThrow("non-local host (db.example.neon.tech:5432/prod_db)");
  });

  it("a remote host WITH --allow-remote resolves, and the banner names host, port and database", () => {
    const t = resolveTarget(["dev", "up", "1", "--allow-remote"], { DATABASE_URL: PROD });
    expect(t.databaseUrl).toBe(PROD);
    expect(t.count).toBe(1);
    expect(t.banner).toBe("migrate dev up 1: db.example.neon.tech:5432/prod_db (from DATABASE_URL)");
  });

  it("--local does not make a remote DATABASE_URL acceptable", () => {
    expect(() => resolveTarget(["dev", "up", "--local"], { DATABASE_URL: PROD })).toThrow(/non-local host/);
  });

  it("neither the banner nor any error ever contains the user or password (positive control: they are in the input)", () => {
    expect(PROD).toContain("s3cret-pw");
    const ok = resolveTarget(["dev", "up", "--allow-remote"], { DATABASE_URL: PROD });
    expect(ok.banner).not.toMatch(/s3cret-pw|app_owner/);
    let message = "";
    try {
      resolveTarget(["dev", "up"], { DATABASE_URL: PROD });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toMatch(/s3cret-pw|app_owner/);
  });

  it("an unparseable URL throws without echoing it", () => {
    let message = "";
    try {
      resolveTarget(["dev", "up"], { DATABASE_URL: "not a url s3cret-pw" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/not a valid URL/);
    expect(message).not.toContain("s3cret-pw");
  });

  it("the test target uses TEST_DATABASE_URL, and still refuses a remote host", () => {
    expect(resolveTarget(["test", "up"], { TEST_DATABASE_URL: LOCAL.replace("thinkersjournal", "tj_t") }).database).toBe("tj_t");
    expect(() => resolveTarget(["test", "up"], { TEST_DATABASE_URL: PROD })).toThrow(/TEST_DATABASE_URL points at a non-local host/);
  });

  it("the test target keeps its throwaway localhost default", () => {
    expect(resolveTarget(["test", "up"], { DATABASE_URL: PROD }).database).toBe("thinkersjournal_test");
  });

  it("the test target ignores DATABASE_URL entirely (a prod URL in it cannot redirect a test run)", () => {
    expect(resolveTarget(["test", "up"], { DATABASE_URL: PROD }).host).toBe("localhost");
  });

  it("an unknown flag throws instead of being ignored (a typo must not read as 'no flag')", () => {
    expect(() => resolveTarget(["dev", "up", "--allow-remot"], { DATABASE_URL: PROD })).toThrow(/unknown flag --allow-remot/);
  });

  it("an unknown target throws", () => {
    expect(() => resolveTarget(["prod", "up", "--local"], {})).toThrow(/unknown target "prod"/);
  });

  it("flags may appear anywhere and do not disturb the positionals", () => {
    expect(parseArgs(["--local", "dev", "down", "2"])).toEqual({ target: "dev", direction: "down", count: 2 });
  });

  it("describeTarget defaults the port to 5432", () => {
    expect(describeTarget("postgres://u:p@h/d")).toEqual({ host: "h", port: "5432", database: "d" });
  });
});
