import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #156 (PM ruling): the `web` Worker has NO test routes and NO `TEST_ROUTES`
 * switch. The ledger e2e reaches web's failed-purge counting path from the api's
 * TEST_ROUTES seam instead. This pins that nothing slipped onto web.
 *
 * Enumerated from the index (`git ls-files`), never by walking the disk.
 */
const root = join(import.meta.dirname, "..");

/** Lines that are code, not comment (lines starting with a line-comment or block-comment marker are dropped). */
function codeLines(text: string): string[] {
  return text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

function offends(text: string): boolean {
  return codeLines(text).some((l) => /TEST_ROUTES|["'`/]__test\b/.test(l));
}

function trackedUnder(dir: string): string[] {
  const out = execFileSync("git", ["ls-files", "--", dir], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter((f) => f.length > 0);
}

describe("web Worker carries no test routes (#156)", () => {
  it("positive control: the matcher flags a TEST_ROUTES gate and a __test route, and ignores comments", () => {
    expect(offends('if (env.TEST_ROUTES === "1") return;')).toBe(true);
    expect(offends('const p = "/__test/anything";')).toBe(true);
    expect(offends(" * the `__test` prefix does not transfer, TEST_ROUTES either")).toBe(false);
  });

  it("no web source file gates on TEST_ROUTES or serves a /__test path", () => {
    const files = trackedUnder("src").filter((f) => /\.(ts|astro|mjs|js)$/.test(f));
    expect(files.length).toBeGreaterThan(20); // control: the index enumeration found the tree
    const bad = files.filter((f) => offends(readFileSync(join(root, f), "utf8")));
    expect(bad).toEqual([]);
    expect(files.some((f) => /(^|\/)__test/.test(f))).toBe(false);
  });

  it("wrangler.jsonc declares no TEST_ROUTES var", () => {
    const text = readFileSync(join(root, "wrangler.jsonc"), "utf8");
    expect(text.length).toBeGreaterThan(100);
    expect(offends(text)).toBe(false);
  });
});
