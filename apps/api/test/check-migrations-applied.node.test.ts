import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MIGRATION_NAME_RE,
  evaluate,
  findDisallowedMigrationFiles,
  pickGateMigration,
} from "../../../scripts/lib/migration-gate.mjs";

/** Shared by both source-level checks below. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Replaces a `= /.../;` regex-literal assignment tail with a placeholder, so
 * a quantifier's braces (`{4}`, `{1,100}`) don't confuse the brace-depth
 * counter in `topLevelStatements` below — those braces are balanced in
 * isolation but appear mid-statement, not around an actual block, which a
 * naive counter can't tell apart from a real block boundary without this.
 */
function neutralizeRegexLiterals(source: string): string {
  return source.replace(/=\s*\/[^\n]*\/;/g, "= /*regex*/;");
}

/**
 * Splits `source` into its top-level statements by brace depth (every `{`
 * is +1, every `}` is -1; a statement ends at a `;` or a `}` that returns
 * depth to 0). Good enough for OUR hand-written library files specifically
 * — not a general JS parser — because every brace in them is either a real
 * block delimiter or (after `neutralizeRegexLiterals`) balanced within the
 * same statement, so the running depth is always accurate at each
 * candidate split point.
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
 * EITHER:
 *   - `export (async )?function ...` — defining a function has no effect;
 *     calling it would, but nothing here does that at the top level.
 *   - `export const|let NAME = <initializer>;` — ONLY IF the initializer
 *     contains no call expression (an identifier directly followed by `(`).
 *     `export const x = sideEffect();` DOES run `sideEffect()` at import
 *     time and must be rejected — a bare "starts with export" check would
 *     wrongly pass it.
 *
 * Anything else (a bare statement, a different export form) is unsafe.
 *
 * ⚠️ NOT A GENERAL JS PARSER — text-based, not AST-based. A call nested
 * inside its OWN function body within a const initializer (`export const f
 * = () => sideEffect()`) is not actually a top-level call (it only runs when
 * `f` is invoked), but this would flag it anyway. That's a false positive,
 * not a false negative — it fails closed, the safe direction for a check
 * with this name — and no file here currently has that shape.
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
 * The deploy-time migration gate (#116, shape A). Covers the PURE library
 * (`scripts/lib/migration-gate.mjs`) and, separately, a source-level pin on
 * the CLI (`scripts/check-migrations-applied.mjs`) that it still has no
 * entry-point guard — see that library's own header for why the guard was
 * removed (fix round 2 ruling: round 1's version could fail open).
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

/**
 * ⚠️ WHY A STRUCTURAL CHECK, NOT A FRESH DYNAMIC RE-IMPORT (fix round 2, item
 * 4). An earlier draft stubbed `fetch`, cache-busted a dynamic `import()` of
 * the lib, and asserted the stub was never called. That timed out under
 * full-suite load at the node project's 5000ms default (reproduced:
 * 5020-5027ms, both lib files) — a fresh cache-busted specifier forces
 * Vite's transform pipeline to build a new module graph entry, and that
 * pipeline contends under heavy parallel load. The property doesn't need a
 * fresh import: checking that every top-level statement is a side-effect-
 * free export (below) proves the same thing statically, in microseconds.
 */
describe("fix round 2, item 4: the library has no side effects, proven structurally and fast", () => {
  const libSource = neutralizeRegexLiterals(
    stripComments(
      readFileSync(
        join(import.meta.dirname, "..", "..", "..", "scripts", "lib", "migration-gate.mjs"),
        "utf8",
      ),
    ),
  );
  const statements = topLevelStatements(libSource);

  it("found at least one top-level statement (positive control — the scan isn't vacuously passing)", () => {
    expect(statements.length).toBeGreaterThan(0);
  });

  it("every top-level statement in scripts/lib/migration-gate.mjs is a side-effect-free export", () => {
    const unsafe = statements.filter((s) => !isSafeTopLevelStatement(s));
    expect(unsafe).toEqual([]);
  });
});

describe("fix round 2, item 3: the CLI has no entry-point guard (source-level pin)", () => {
  // Source-level pin, same technique as apps/web/test/db-health-proxy.test.ts —
  // reads the file as TEXT rather than importing it, since importing the CLI
  // module runs `main()` for real (unconditionally, by design: see its header).
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
