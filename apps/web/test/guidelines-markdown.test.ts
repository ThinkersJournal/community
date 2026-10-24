// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GUIDELINES_EFFECTIVE_DATE, GUIDELINES_PATH, GUIDELINES_VERSION } from "@thinkersjournal/shared";

const md = readFileSync(join(import.meta.dirname, "../../../docs/legal/community-guidelines.md"), "utf8");

describe("published Community Guidelines: version stamp drift", () => {
  it("has exactly one stamp line, and it matches the constants", () => {
    const lines = md.split(/\r?\n/).filter((l) => /^\*\*Version:\*\*/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`**Version:** ${GUIDELINES_VERSION} · **Effective:** ${GUIDELINES_EFFECTIVE_DATE}`);
  });

  it("constants are well-formed", () => {
    expect(GUIDELINES_EFFECTIVE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(GUIDELINES_VERSION.length).toBeGreaterThan(0);
    expect(GUIDELINES_PATH).toBe("/guidelines");
  });
});

describe("published Community Guidelines: public-text guard", () => {
  it("has no unresolved placeholder, draft marker or 'not yet true' note", () => {
    expect(md).not.toContain("[[");
    expect(md).not.toContain("]]");
    expect(md).not.toMatch(/\bDRAFT\b/);
    expect(md).not.toMatch(/not yet/i);
    expect(md).not.toMatch(/attorney/i);
  });

  it("does not promise what the code does not do (see 2026-10-15-guidelines-intentions.md)", () => {
    expect(md).not.toMatch(/NCMEC|CSAM/);
    expect(md).not.toMatch(/terminat/i);
    expect(md).not.toMatch(/reclaim/i);
    expect(md).not.toMatch(/machine-scored|scoring/i);
    expect(md).not.toMatch(/bad faith/i);
  });

  it("links to no unpublished document", () => {
    expect(md).not.toMatch(/\]\([^)]*\.md\)/);
  });

  it("keeps section 1 items 1-10 in place (the contractual-ground mapping depends on the numbers)", () => {
    const nl = String.fromCharCode(10);
    const section = nl + md.split(nl + "## 2. ")[0]!;
    const starts = [
      "Is illegal",
      "Sexually exploits",
      "Threatens",
      "Is hate speech",
      "Is non-consensual",
      "Doxxes",
      "Is spam",
      "Distributes malware",
      "Impersonates",
      "Infringes",
    ];
    starts.forEach((s, i) => {
      expect(section, `item ${i + 1}`).toContain(nl + String(i + 1) + ". **" + s);
    });
  });
});
