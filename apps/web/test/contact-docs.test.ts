// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTACT_EMAIL, DISPUTE_EMAIL } from "@thinkersjournal/shared";

const dir = join(import.meta.dirname, "../../../docs/legal");
const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");

describe("docs/legal contact addresses match packages/shared/src/contact.ts", () => {
  it("no document carries the [[CONTACT_EMAIL]] placeholder", () => {
    for (const f of files) expect(readFileSync(join(dir, f), "utf8"), f).not.toContain("[[CONTACT_EMAIL]]");
  });

  it("every @thinkersjournal.com address in the published docs is one of the constants or the DMCA agent's", () => {
    const allowed = new Set([CONTACT_EMAIL, DISPUTE_EMAIL]);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const m of text.match(/[A-Za-z0-9._-]+@thinkersjournal\.com/g) ?? []) {
        if (f === "dmca-policy.md") continue; // the designated agent's registered address is its own record
        expect(allowed.has(m), `${f}: ${m}`).toBe(true);
      }
    }
  });

  it("the guidelines, terms and privacy policy each name the general contact", () => {
    for (const f of ["community-guidelines.md", "terms-of-service.md", "privacy-policy.md"]) {
      expect(readFileSync(join(dir, f), "utf8"), f).toContain(CONTACT_EMAIL);
    }
  });
});
