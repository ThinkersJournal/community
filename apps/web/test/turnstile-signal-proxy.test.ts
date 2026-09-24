import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `POST /api/turnstile-signal` — the countable Turnstile client-side
 * failure signal (PM task, 2026-09-24). Source-level pin, matching this
 * repo's convention for a route that imports `cloudflare:workers`
 * (indirectly, via markPrivate) and so cannot be rendered outside workerd.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const code = stripComments(
  readFileSync(join(import.meta.dirname, "..", "src", "pages", "api", "turnstile-signal.ts"), "utf8"),
);

describe("POST /api/turnstile-signal", () => {
  it("is markPrivate — never cached", () => {
    expect(code).toContain("markPrivate(");
  });

  it("logs via console.error with a structured, greppable message — the same 'Workers Logs is the observability surface' pattern used elsewhere in this repo", () => {
    expect(code).toContain('console.error("turnstile client-side failure"');
  });

  it("⚠️ only accepts the two known kinds — anything else logs as 'unknown', never echoes an arbitrary client-supplied string into the log", () => {
    expect(code).toContain('"widget_error"');
    expect(code).toContain('"widget_timeout"');
    expect(code).toMatch(/let kind = "unknown"/);
    expect(code).toMatch(/KINDS\.has\(body\.kind\)/);
  });

  it("⚠️ never logs anything that could be a token — the request body has no field capable of carrying one", () => {
    // Anti-vacuity: the ONLY body field ever read is `kind`, and the log
    // call's own arguments are `kind` + Referer, nothing echoing arbitrary
    // request content.
    expect(code).not.toMatch(/body\.token|body\.response/);
    const logCallAt = code.indexOf('console.error("turnstile client-side failure"');
    const logArgs = code.slice(logCallAt, logCallAt + 200);
    expect(logArgs).toContain("kind");
    expect(logArgs).toContain("page");
    expect(logArgs).not.toMatch(/token/i);
  });

  it("a malformed/empty JSON body does not throw — still logged as 'unknown', still answers 204", () => {
    expect(code).toMatch(/catch \{[\s\S]{0,120}\}/);
    expect(code).toContain("status: 204");
  });
});
