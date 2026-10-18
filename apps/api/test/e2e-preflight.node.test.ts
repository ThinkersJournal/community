import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  checkDevDb,
  listMigrationNames,
} from "../scripts/lib/e2e-preflight.mjs";

/**
 * The e2e preflight (#84): `pnpm test:e2e` against a persistent local dev DB
 * that is behind the migration files used to hang for the full webServer
 * timeout (repeated 503 on `/`, which needs `GET /public/discover`). The check
 * must fail FAST, name the fix, and touch nothing but a LOCAL database.
 *
 * Pure: `checkDevDb` takes the ledger query as a parameter, so no Postgres is
 * needed here (and none is started). Touches no database.
 */

const URL_LOCAL = "postgres://postgres:s3cret@localhost:5432/thinkersjournal";
const FILES = ["0001_a", "0002_b", "0003_c", "0005_e"]; // a gap on purpose: files are not 1..N
const MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

const errWithCode = (code: string, message = code): Error => Object.assign(new Error(message), { code });

describe("checkDevDb", () => {
  it("unmigrated DB: fails fast, with ledger N < files M and the command to run", async () => {
    const r = await checkDevDb({
      databaseUrl: URL_LOCAL,
      migrationNames: FILES,
      queryApplied: async () => ["0001_a"],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("unmigrated");
    expect(r.message).toContain("dev DB unmigrated (ledger 1 < files 4)");
    expect(r.message).toContain("pnpm --filter @thinkersjournal/api run migrate");
    // Names which are missing, so a reader can tell "behind" from "different branch".
    expect(r.message).toContain("0002_b");
    expect(r.message).toContain("0005_e");
  });

  it("a DB with no pgmigrations table is ledger 0, not a crash", async () => {
    const r = await checkDevDb({
      databaseUrl: URL_LOCAL,
      migrationNames: FILES,
      queryApplied: async () => {
        throw errWithCode("42P01", 'relation "pgmigrations" does not exist');
      },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("ledger 0 < files 4");
  });

  it("a fully migrated DB passes", async () => {
    const r = await checkDevDb({
      databaseUrl: URL_LOCAL,
      migrationNames: FILES,
      queryApplied: async () => [...FILES],
    });
    expect(r).toMatchObject({ ok: true, status: "ok" });
  });

  it("a ledger AHEAD of the files (another branch migrated further) passes", async () => {
    const r = await checkDevDb({
      databaseUrl: URL_LOCAL,
      migrationNames: FILES,
      queryApplied: async () => [...FILES, "0099_from_another_branch"],
    });
    expect(r.ok).toBe(true);
  });

  it("compares NAMES, not counts: same number of rows, one different, still unmigrated", async () => {
    const r = await checkDevDb({
      databaseUrl: URL_LOCAL,
      migrationNames: FILES,
      queryApplied: async () => ["0001_a", "0002_b", "0003_c", "0004_not_a_file"],
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("0005_e");
  });

  it("refuses to look at a non-local database: no query, no password in the message", async () => {
    const queryApplied = vi.fn(async () => FILES);
    const r = await checkDevDb({
      databaseUrl: "postgres://neondb_owner:hunter2@ep-example.neon.tech/neondb",
      migrationNames: FILES,
      queryApplied,
    });
    expect(queryApplied).not.toHaveBeenCalled();
    expect(r.status).toBe("skipped-nonlocal");
    expect(r.ok).toBe(true); // skipped, and says so; it is a convenience check, not a gate
    expect(r.message).toContain("ep-example.neon.tech");
    expect(r.message).not.toContain("hunter2");
  });

  it("Postgres not running: fails fast naming host:port, never the password", async () => {
    const r = await checkDevDb({
      databaseUrl: URL_LOCAL,
      migrationNames: FILES,
      queryApplied: async () => {
        throw errWithCode("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("unreachable");
    expect(r.message).toContain("localhost:5432");
    expect(r.message).not.toContain("s3cret");
  });

  it("database missing: fails fast and names the database", async () => {
    const r = await checkDevDb({
      databaseUrl: URL_LOCAL,
      migrationNames: FILES,
      queryApplied: async () => {
        throw errWithCode("3D000", 'database "thinkersjournal" does not exist');
      },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("no-database");
    expect(r.message).toContain("thinkersjournal");
  });

  it("any other error fails closed with its message", async () => {
    const r = await checkDevDb({
      databaseUrl: URL_LOCAL,
      migrationNames: FILES,
      queryApplied: async () => {
        throw new Error("boom");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("error");
    expect(r.message).toContain("boom");
  });

  it("an empty migration list is an error, not a vacuous pass", async () => {
    const r = await checkDevDb({ databaseUrl: URL_LOCAL, migrationNames: [], queryApplied: async () => [] });
    expect(r.ok).toBe(false);
  });
});

describe("listMigrationNames", () => {
  it("keeps only .sql files, without the extension, sorted", () => {
    expect(listMigrationNames(["0002_b.sql", "README.md", "0001_a.sql", ".gitkeep"])).toEqual(["0001_a", "0002_b"]);
  });

  it("against the real directory: finds the real migrations, and a ledger missing the newest is caught", async () => {
    const names = listMigrationNames(readdirSync(MIGRATIONS_DIR));
    expect(names.length).toBeGreaterThan(30); // non-vacuity
    expect(names).toContain("0001_users_and_profiles");
    const newest = names[names.length - 1]!;
    const r = await checkDevDb({
      databaseUrl: URL_LOCAL,
      migrationNames: names,
      queryApplied: async () => names.slice(0, -1),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain(newest);
  });
});

describe("wiring", () => {
  it("playwright.config.ts runs the preflight BEFORE the web build and the first wrangler dev", () => {
    const cfg = readFileSync(join(import.meta.dirname, "../../../playwright.config.ts"), "utf8");
    const pre = cfg.indexOf("e2e-preflight.mjs");
    const build = cfg.indexOf('"pnpm --filter @thinkersjournal/web build"');
    expect(pre).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(build);
  });
});
