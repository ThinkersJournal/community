// SPDX-License-Identifier: MIT OR Apache-2.0
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Spec 3.3 / section 9: a connector may not call global `fetch`; `ctx.fetch` (the SSRF-guarded door) is the only
 * way out. This is a SOURCE scan, so it runs in the Node project (workerd's filesystem is virtual).
 *
 * Mutation that must fail it: add a bare `fetch(` (or `globalThis.fetch`) to a file under
 * src/references/connectors/ (M3.1b's `web` connector).
 */
const CONNECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "references", "connectors");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every reference to the GLOBAL fetch: bare `fetch`, `globalThis.fetch`, `self.fetch`, `window.fetch`. */
function globalFetchReferences(src: string): string[] {
  const code = stripComments(src);
  const hits: string[] = [];
  const re = /(?<![\w$])((?:globalThis|self|window)\s*\.\s*)?fetch(?![\w$])/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const before = code.slice(0, m.index).trimEnd();
    if (!m[1] && before.endsWith(".")) continue; // ctx.fetch / this.ctx.fetch
    hits.push(m[0]);
  }
  return hits;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

describe("connector door", () => {
  it("the scanner flags global fetch and ignores ctx.fetch (positive control)", () => {
    expect(globalFetchReferences("const r = await fetch(url);")).toHaveLength(1);
    expect(globalFetchReferences("await globalThis.fetch(url)")).toHaveLength(1);
    expect(globalFetchReferences("const f = fetch;")).toHaveLength(1);
    expect(globalFetchReferences("await ctx.fetch(url)")).toHaveLength(0);
    expect(globalFetchReferences("await this.ctx\n  .fetch(url) // fetch(url) in a comment")).toHaveLength(0);
    expect(globalFetchReferences("const prefetch = 1; fetchLive(x)")).toHaveLength(0);
  });

  it("the connectors directory exists", () => {
    expect(existsSync(CONNECTORS_DIR)).toBe(true);
  });

  it("no file under src/references/connectors references global fetch", () => {
    const offenders = listFiles(CONNECTORS_DIR)
      .filter((p) => /\.(ts|tsx|js|mjs)$/.test(p))
      .filter((p) => globalFetchReferences(readFileSync(p, "utf8")).length > 0);
    expect(offenders).toEqual([]);
  });
});
