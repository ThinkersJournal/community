// SPDX-License-Identifier: MIT OR Apache-2.0
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Spec 3.3 / section 9: nothing under src/references/ except the guarded fetch itself may reach the network any way but
 * `ctx.fetch` (the SSRF-guarded door). This is a SOURCE scan, so it runs in the Node project (workerd's filesystem is
 * virtual). It walks the TypeScript syntax tree (no regex over source text), so a `//` inside a string, aliasing
 * through `globalThis`, bracket access and `import { fetch }` cannot hide a use.
 *
 * Mutation that must fail it: add a bare `fetch(` (or `globalThis.fetch`, `new WebSocket(...)`, an import of
 * undici/node-fetch/cloudflare:sockets) to any file under src/references/ other than guarded-fetch.ts.
 */
const REFERENCES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "references");
const EXEMPT = new Set(["guarded-fetch.ts"]);

const BANNED_GLOBALS = new Set(["globalThis", "self", "window", "global", "WebSocket", "XMLHttpRequest", "EventSource"]);
const BANNED_MODULES = new Set([
  "undici", "node-fetch", "cross-fetch", "axios", "got", "cloudflare:sockets",
  "http", "https", "net", "tls", "node:http", "node:https", "node:net", "node:tls",
]);

function isCtxReceiver(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === "ctx";
  return ts.isPropertyAccessExpression(node) && node.name.text === "ctx";
}

function moduleName(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    const callee = node.expression;
    const first = node.arguments[0];
    const isLoader = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
    if (isLoader && first && ts.isStringLiteralLike(first)) return first.text;
  }
  return undefined;
}

function isPropertyNameOfAccess(node: ts.Identifier): boolean {
  const parent = node.parent;
  return ts.isPropertyAccessExpression(parent) && parent.name === node;
}

function classifyIdentifier(node: ts.Identifier): string | undefined {
  if (node.text === "fetch") {
    const parent = node.parent;
    const viaCtx = ts.isPropertyAccessExpression(parent) && parent.name === node && isCtxReceiver(parent.expression);
    return viaCtx ? undefined : "fetch not reached through ctx";
  }
  if (BANNED_GLOBALS.has(node.text) && !isPropertyNameOfAccess(node)) return `global ${node.text}`;
  return undefined;
}

/** Every forbidden network reference in `source`, as short human descriptions. */
function forbiddenReferences(source: string, fileName = "fixture.ts"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const hit = classifyIdentifier(node);
      if (hit) hits.push(hit);
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "fetch" && !isCtxReceiver(node.expression)) {
      hits.push("bracket access to fetch");
    }
    const mod = moduleName(node);
    if (mod !== undefined && BANNED_MODULES.has(mod)) hits.push(`module ${mod}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

describe("connector door: the scanner (a positive control per banned form, as fixture strings)", () => {
  it.each([
    ["bare call", "const r = await fetch(url);"],
    ["alias", "const f = fetch; f(url);"],
    ["globalThis property", "await globalThis.fetch(url)"],
    ["globalThis alias", "const g = globalThis; g.fetch(url);"],
    ["globalThis bracket", 'await globalThis["fetch"](url)'],
    ["self", "self.fetch(url)"],
    ["window", "window.fetch(url)"],
    ["bracket on another object", 'await thing["fetch"](url)'],
    ["// inside a string hiding code", 'const s = "// not a comment"; fetch(url);'],
    ["named import", 'import { fetch } from "./x";'],
    ["renamed import", 'import { fetch as f } from "./x";'],
    ["method named fetch on a non-ctx object", "other.fetch(url)"],
    ["undici import", 'import { request } from "undici";'],
    ["node-fetch import", 'import nf from "node-fetch";'],
    ["sockets import", 'import { connect } from "cloudflare:sockets";'],
    ["dynamic import", 'const m = await import("undici");'],
    ["require", 'const m = require("node-fetch");'],
    ["WebSocket", "const w = new WebSocket(url);"],
    ["XMLHttpRequest", "const x = new XMLHttpRequest();"],
  ])("flags %s", (_name, source) => {
    expect(forbiddenReferences(source).length).toBeGreaterThan(0);
  });

  it.each([
    ["ctx.fetch", "await ctx.fetch(url)"],
    ["this.ctx.fetch across lines", "await this.ctx\n  .fetch(url)"],
    ["a comment", "// fetch(url) and globalThis.fetch in a comment\n/* fetch( */ const a = 1;"],
    ["a string", 'const s = "call fetch(url) later";'],
    ["a longer identifier", "const prefetch = 1; fetchLive(x); selfHosts.has(h);"],
    ["ctx bracket", 'await ctx["fetch"](url)'],
  ])("allows %s", (_name, source) => {
    expect(forbiddenReferences(source)).toEqual([]);
  });
});

describe("connector door: the source tree", () => {
  it("the references and connectors directories exist", () => {
    expect(existsSync(REFERENCES_DIR)).toBe(true);
    expect(existsSync(join(REFERENCES_DIR, "connectors"))).toBe(true);
  });

  it("scans real files (not an empty set)", () => {
    const scanned = listFiles(REFERENCES_DIR).filter((p) => /\.tsx?$/.test(p) && !EXEMPT.has(p.slice(REFERENCES_DIR.length + 1)));
    expect(scanned.length).toBeGreaterThanOrEqual(2);
  });

  it("no file under src/references/ except guarded-fetch.ts reaches the network any way but ctx.fetch", () => {
    const offenders = listFiles(REFERENCES_DIR)
      .filter((p) => /\.tsx?$/.test(p) && !EXEMPT.has(p.slice(REFERENCES_DIR.length + 1)))
      .map((p) => ({ file: p.slice(REFERENCES_DIR.length + 1), hits: forbiddenReferences(readFileSync(p, "utf8"), p) }))
      .filter((o) => o.hits.length > 0);
    expect(offenders).toEqual([]);
  });
});
