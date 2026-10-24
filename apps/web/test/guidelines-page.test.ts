// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { GUIDELINES_EFFECTIVE_DATE, GUIDELINES_VERSION } from "@thinkersjournal/shared";

import Guidelines from "../src/pages/guidelines.astro";
import { guidelinesBody } from "../src/lib/guidelines";
import { json, renderPage } from "./helpers/render-page";

// The container has no Workers cache (`Astro.cache` is undefined there), so the
// helper is stubbed to a recorder. That the page calls it once, with the right
// tag, is asserted on the recorder AND on the source below.
const marked: string[][] = [];
vi.mock("../src/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/cache")>()),
  markPublicCacheable: (_ctx: unknown, tags: string[]) => {
    marked.push(tags);
    return true;
  },
}));

const pageSrc = () =>
  readFileSync(join(import.meta.dirname, "../src/pages/guidelines.astro"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("/guidelines page", () => {
  it("renders the heading, the version, the effective date and a known clause", async () => {
    const res = await renderPage(Guidelines, {
      url: "http://localhost/guidelines",
      api: () => json(500, {}),
    });
    expect(res.status).toBe(200);
    expect(marked.at(-1)).toEqual(["guidelines"]);
    const html = await res.text();
    expect(html).toContain("<h1>Community Guidelines</h1>");
    expect(html).toContain(`Version ${GUIDELINES_VERSION}`);
    expect(html).toContain(`Effective ${GUIDELINES_EFFECTIVE_DATE}`);
    // A known clause from each half of the document.
    expect(html).toContain("What is not allowed");
    expect(html).toContain("Doxxes");
    expect(html).toContain("several different");
    expect(html).toContain("within 30 days");
    // Positive control for the guards below: the page really contains the body.
    expect(html.length).toBeGreaterThan(4000);
  });

  it("shows no placeholder, draft marker or 'not yet' note", async () => {
    const res = await renderPage(Guidelines, { url: "http://localhost/guidelines", api: () => json(500, {}) });
    const html = await res.text();
    expect(html).not.toContain("[[");
    expect(html).not.toMatch(/\bDRAFT\b/);
    expect(html).not.toMatch(/not yet/i);
  });

  it("is anonymous and edge-cacheable (one cache helper), with the public CSP, and reads no api", () => {
    const s = pageSrc();
    expect(s).toMatch(/markPublicCacheable\(Astro,\s*\[\s*["']guidelines["']/);
    expect(s).not.toContain("markPrivate(");
    expect(s).not.toContain("markFeedCacheable(");
    expect(s).toContain("setPublicPageCsp(Astro)");
    expect(s).not.toContain("apiFetch");
  });
});

describe("guidelinesBody", () => {
  it("drops the title and the stamp line (the page renders both from the constants)", () => {
    const body = guidelinesBody();
    expect(body).not.toMatch(/^# /m);
    expect(body).not.toContain("**Version:**");
    expect(body).toContain("## 1. What is not allowed");
  });

  it("control: it strips only those two lines from a synthetic file", () => {
    expect(guidelinesBody("# T\r\n\r\n**Version:** x · **Effective:** y\r\n\r\n## A\r\ntext\r\n")).toBe("## A\ntext");
  });
});
