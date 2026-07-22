import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const tokens = () => readFileSync(join(ROOT, "src/styles/tokens.css"), "utf8");
const global = () => readFileSync(join(ROOT, "src/styles/global.css"), "utf8");

describe("design tokens", () => {
  it("defines the chrome-critical custom properties", () => {
    const t = tokens();
    for (const token of ["--ink:#060608", "--green:#3dff95", "--text:#f3f3f5", "--muted:#a8a8b3",
      "--head:#fafafc", "--on-green:#03130a", "--line:rgba(255,255,255,.08)",
      "--green-glow:rgba(61,255,149,.5)", "--wrap:1120px"]) {
      expect(t.replace(/\s/g, "")).toContain(token.replace(/\s/g, ""));
    }
    expect(t).toContain("'Fraunces Variable'");
    expect(t).toContain("'Inter Variable'");
  });
  it("is dark-only (no prefers-color-scheme)", () => {
    expect(tokens()).not.toContain("prefers-color-scheme");
    expect(global()).not.toContain("prefers-color-scheme:light");
  });
});

describe("global css", () => {
  it("imports tokens and defines the utility classes + serif headings", () => {
    const g = global();
    expect(g).toContain("@import './tokens.css'");
    for (const cls of [".wrap", ".serif", ".label", ".btn", ".btn-primary", ".btn-ghost", ".link"]) {
      expect(g).toContain(cls);
    }
    expect(g).toMatch(/h1,\s*h2,\s*h3\{[^}]*var\(--serif\)/);
    expect(g).toContain(":focus-visible");
    expect(g).toContain("prefers-reduced-motion");
  });
});

describe("fonts + favicon are declared", () => {
  it("adds both Fontsource variable packages as web deps", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies["@fontsource-variable/fraunces"]).toBeDefined();
    expect(pkg.dependencies["@fontsource-variable/inter"]).toBeDefined();
  });
  it("ships a favicon", () => {
    expect(existsSync(join(ROOT, "public/favicon.svg"))).toBe(true);
  });
});
