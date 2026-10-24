// SPDX-License-Identifier: MIT OR Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ⚠️ NO GENERAL XML PARSER IS REACHABLE FROM THE DSA NOTICE-AND-ACTION INTAKE.
 *
 * Pins the claim in the XML-parser decision record
 * (docs/superpowers/specs/2026-09-08-xml-parser-decision.md, PR #36), tracked
 * as issue #40: if `fast-xml-parser` is ever added it is for the NCMEC
 * CyberTipline path ONLY, never the DSA path, because the DSA intake is an HTML
 * form + Turnstile + email round-trip with no XML anywhere. That narrowness is a
 * property of the current code, not of the library — this test is what makes it
 * maintained rather than remembered.
 *
 * ⚠️ HONEST SCOPE. The NCMEC/CyberTipline side DOES NOT EXIST YET. So only the
 * DSA half is pinned as a reachability claim. The CyberTipline half is pinned
 * only as "no XML parser import outside an explicit allowlist" (empty today).
 * When that module lands, the PR that adds it must add it to
 * ALLOWED_XML_IMPORTERS and should add the characterization tests #40 asks for.
 *
 * WHAT IS CHECKED: (1) no import/require specifier on the DSA path (files +
 * transitive relative imports, `@thinkersjournal/shared` resolved to
 * packages/shared/src) names an XML package; (2) no DOMParser/parseXml/XMLParser
 * identifier; (3) no XML content-type literal. Comments are stripped first so
 * prose about the rule cannot trip it.
 *
 * NOT CHECKED (limitations): dynamic specifiers built at runtime, path aliases
 * other than the shared package, third-party packages' own transitive
 * dependencies (node_modules is not walked), and non-import routes to a parser.
 * apps/web `devDependencies` (fast-xml-parser, used by e2e) are permitted;
 * `dependencies` are not.
 *
 * Non-vacuity controls are asserted explicitly: over two empty sets this would
 * pass for nothing (#36's own documented failure class).
 *
 * `.node.test.ts` because it reads real files (workerd's FS is virtual).
 * Touches NO database. Enumerates with `git ls-files`, never a disk walk.
 */

const REPO_ROOT = join(import.meta.dirname, "../../..");

/** Repo-relative importers permitted to import an XML parser. Empty today: the
 *  future CyberTipline module is the ONLY permitted entry, added by the PR that
 *  adds it. */
const ALLOWED_XML_IMPORTERS: readonly string[] = [];

const DSA_ROOTS = [
  "apps/api/src/routes/dsa-notice.ts",
  "apps/api/src/moderation/dsa-notices.ts",
  "apps/web/src/pages/dsa-notice.astro",
  "apps/web/src/pages/dsa-notice/confirm.astro",
  "apps/web/src/pages/admin/dsa-notices.astro",
];

const XML_NAMED = /^(fast-xml-parser|xml2js|xml-js|txml|sax|@?xmldom(\/.*)?)$/i;
const XML_ANY = /xml/i;
const SRC_EXT = /\.(ts|tsx|js|mjs|cjs|astro)$/;

const tracked: string[] = execFileSync("git", ["ls-files", "-z"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter((p) => p.length > 0);
const trackedSet = new Set(tracked);

function stripComments(src: string): string {
  // HTML comments in .astro are deliberately NOT stripped: a regex sanitiser for them is
  // incomplete by construction (CodeQL js/incomplete-multi-character-sanitization), and
  // leaving them in can only ADD matches — a conservative false positive, never a missed
  // parser import.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Every import/require/dynamic-import specifier in the (comment-stripped) text. */
function extractSpecifiers(src: string): string[] {
  const text = stripComments(src);
  const out: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.push(m[1]!);
  return out;
}

/** Package names only: a RELATIVE specifier such as `../lib/xml` is the repo's own
 *  XML EMITTER (RSS/sitemap), not a parser, so it is judged by the identifier
 *  check instead of by name. */
function isXmlSpecifier(spec: string): boolean {
  if (spec.startsWith(".")) return false;
  return XML_NAMED.test(spec) || XML_ANY.test(spec);
}

function readRepo(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** Resolve a specifier to a tracked repo file, or null if external/unresolvable. */
function resolveSpec(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec === "@thinkersjournal/shared") {
    base = "packages/shared/src/index";
  } else if (spec.startsWith("@thinkersjournal/shared/")) {
    base = "packages/shared/src/" + spec.slice("@thinkersjournal/shared/".length);
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  } else {
    return null;
  }
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".mjs", ".astro"].map((e) => base + e),
    ...["index.ts", "index.js"].map((i) => posix.join(base, i)),
  ];
  return candidates.find((c) => trackedSet.has(c) && SRC_EXT.test(c)) ?? null;
}

function closure(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (seen.has(f) || !trackedSet.has(f)) continue;
    seen.add(f);
    for (const spec of extractSpecifiers(readRepo(f))) {
      const r = resolveSpec(f, spec);
      if (r !== null && !seen.has(r)) queue.push(r);
    }
  }
  return seen;
}

const dsaFiles = closure(DSA_ROOTS);
const MIN_CLOSURE = 15;

describe("no XML parser on the DSA notice-and-action path", () => {
  it("non-vacuity: the DSA path set is non-empty, has every named file, and a real closure", () => {
    for (const root of DSA_ROOTS) {
      expect(trackedSet.has(root), `${root} is not tracked`).toBe(true);
      expect(dsaFiles.has(root), `${root} missing from closure`).toBe(true);
    }
    expect(
      dsaFiles.size,
      `closure has ${dsaFiles.size} files (expected > ${MIN_CLOSURE}): ${[...dsaFiles].sort().join(", ")}`,
    ).toBeGreaterThan(MIN_CLOSURE);
    expect(dsaFiles.has("apps/api/src/http/errors.ts")).toBe(true);
    expect([...dsaFiles].some((f) => f.startsWith("packages/shared/src/"))).toBe(true);
  });

  it("non-vacuity: the specifier extractor and resolver find known imports", () => {
    const specs = extractSpecifiers(readRepo("apps/api/src/routes/dsa-notice.ts"));
    expect(specs).toContain("../moderation/dsa-notices");
    expect(specs).toContain("@thinkersjournal/shared");
    expect(resolveSpec("apps/api/src/routes/dsa-notice.ts", "../moderation/dsa-notices")).toBe(
      "apps/api/src/moderation/dsa-notices.ts",
    );
    for (const bad of ["fast-xml-parser", "xml2js", "@xmldom/xmldom", "sax", "xml-js", "txml", "some-xml-thing"]) {
      expect(isXmlSpecifier(bad), bad).toBe(true);
    }
    expect(isXmlSpecifier("pg")).toBe(false);
    expect(extractSpecifiers(`import { XMLParser } from "fast-xml-parser";`)).toEqual(["fast-xml-parser"]);
  });

  it("(1) no import/require specifier on the DSA path names an XML package", () => {
    const hits: string[] = [];
    for (const f of dsaFiles) {
      for (const spec of extractSpecifiers(readRepo(f))) {
        if (isXmlSpecifier(spec)) hits.push(`${f} imports "${spec}"`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("(2) no DOMParser / parseXml / XMLParser identifier on the DSA path", () => {
    const hits: string[] = [];
    for (const f of dsaFiles) {
      const text = stripComments(readRepo(f));
      for (const m of text.matchAll(/\b(DOMParser|parseXml|XMLParser)\b/g)) {
        hits.push(`${f} uses ${m[1]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("(3) the DSA path accepts no XML content-type", () => {
    const hits: string[] = [];
    for (const f of dsaFiles) {
      const text = stripComments(readRepo(f));
      for (const m of text.matchAll(/(application|text)\/(\w+\+)?xml/gi)) {
        hits.push(`${f} mentions ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("repo-wide: no XML parser outside the allowlist", () => {
  const srcFiles = tracked.filter((p) => /^apps\/(api|web)\/src\//.test(p) && SRC_EXT.test(p));

  it("non-vacuity: the scan covers real api and web source", () => {
    expect(srcFiles.filter((p) => p.startsWith("apps/api/src/")).length).toBeGreaterThan(20);
    expect(srcFiles.filter((p) => p.startsWith("apps/web/src/")).length).toBeGreaterThan(20);
  });

  it("no file under apps/api/src or apps/web/src imports an XML parser, except ALLOWED_XML_IMPORTERS", () => {
    const hits: string[] = [];
    for (const f of srcFiles) {
      if (ALLOWED_XML_IMPORTERS.includes(f)) continue;
      for (const spec of extractSpecifiers(readRepo(f))) {
        if (isXmlSpecifier(spec)) hits.push(`${f} imports "${spec}"`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("api and web package.json `dependencies` contain no XML parser (web devDependencies are fine: e2e)", () => {
    type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    for (const pkg of ["apps/api/package.json", "apps/web/package.json"]) {
      const json = JSON.parse(readRepo(pkg)) as Pkg;
      expect(json.dependencies, `${pkg} has no dependencies block`).toBeDefined();
      expect(Object.keys(json.dependencies ?? {}).filter(isXmlSpecifier), `${pkg} dependencies`).toEqual([]);
    }
    // apps/api must not carry one even as a devDependency.
    const api = JSON.parse(readRepo("apps/api/package.json")) as Pkg;
    expect(Object.keys(api.devDependencies ?? {}).filter(isXmlSpecifier)).toEqual([]);
    // Control: the detector does see web's e2e devDependency, so the scan is live.
    const web = JSON.parse(readRepo("apps/web/package.json")) as Pkg;
    expect(Object.keys(web.devDependencies ?? {}).filter(isXmlSpecifier)).toContain("fast-xml-parser");
  });
});
