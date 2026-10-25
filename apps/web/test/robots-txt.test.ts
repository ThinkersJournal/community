// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CANONICAL_ORIGIN } from "../src/lib/canonical";

describe("public/robots.txt (S22 F8)", () => {
  const text = readFileSync(join(import.meta.dirname, "../public/robots.txt"), "utf8");

  it("points crawlers at the canonical sitemap", () => {
    expect(text).toContain(`Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`);
  });

  it("does not block the whole site", () => {
    expect(text).not.toMatch(/^Disallow:\s*\/\s*$/m);
  });
});
