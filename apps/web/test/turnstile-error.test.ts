import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `src/scripts/turnstile-error.ts` — the Turnstile failure-UX island
 * (PM task, 2026-09-24, following the #89 outage-that-wasn't).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const rawSource = readFileSync(
  join(import.meta.dirname, "..", "src", "scripts", "turnstile-error.ts"),
  "utf8",
);
const code = stripComments(rawSource);

describe("turnstile-error island", () => {
  it("registers TWO separate global callback names — Turnstile calls each independently, with no discriminator", () => {
    expect(code).toContain("window.turnstileOnError");
    expect(code).toContain("window.turnstileOnTimeout");
  });

  it("⚠️ never weakens the widget: no mode/size/bypass changes anywhere in this file", () => {
    // Anti-regression for the PM's explicit boundary: this file's whole job
    // is feedback, never a way to route around a real challenge.
    expect(code).not.toMatch(/data-size|non-interactive|invisible/i);
    expect(code).not.toMatch(/turnstile\.render\(/); // stays implicit-render, no mode switch
  });

  it("reveals the error note and disables Submit on failure — never leaves Submit clickable against a widget that isn't ready", () => {
    expect(code).toMatch(/errorNote\.hidden = false/);
    expect(code).toMatch(/submitBtn[\s\S]{0,40}\.disabled = true/);
  });

  it("retry re-enables Submit and calls turnstile.reset(container) — never a full page reload", () => {
    expect(code).toMatch(/retryBtn\.addEventListener\("click"/);
    expect(code).toMatch(/errorNote\.hidden = true/);
    expect(code).toMatch(/submitBtn[\s\S]{0,40}\.disabled = false/);
    expect(code).toContain("window.turnstile?.reset(container)");
    expect(code).not.toMatch(/location\.reload|location\.href\s*=/);
  });

  it("reports a countable signal to /api/turnstile-signal, fire-and-forget, on both error and timeout", () => {
    expect(code).toContain('fetch("/api/turnstile-signal"');
    expect(code).toMatch(/\.catch\(\(\)\s*=>\s*\{\}\)/); // never surfaces as an unhandled rejection
    expect(code).toContain('"widget_error"');
    expect(code).toContain('"widget_timeout"');
  });

  it("⚠️ never sends the Turnstile error code or any part of a token in the signal body", () => {
    // Anti-vacuity: co-locate the fetch call with its body, and assert the
    // ONLY field sent is `kind` — not the widget's own error-code parameter.
    const fetchCallAt = code.indexOf('fetch("/api/turnstile-signal"');
    const nearby = code.slice(fetchCallAt, fetchCallAt + 300);
    expect(nearby).toMatch(/body:\s*JSON\.stringify\(\{\s*kind\s*\}\)/);
    expect(nearby).not.toMatch(/errorCode|token/);
  });

  it("only wires when the real widget's DOM is present — no-ops entirely for the dev/e2e dummy-token fallback", () => {
    expect(code).toMatch(
      /if \(container === null \|\| errorNote === null \|\| retryBtn === null\) return;/,
    );
  });

  it("exports initTurnstileErrorHandling", () => {
    expect(code).toContain("export function initTurnstileErrorHandling");
  });
});
