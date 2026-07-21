import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ISLAND = join(import.meta.dirname, "../src/scripts/social.ts");
const PROFILE = join(import.meta.dirname, "../src/pages/[handle]/index.astro");
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const island = stripComments(readFileSync(ISLAND, "utf8"));
const profile = stripComments(readFileSync(PROFILE, "utf8"));

describe("island list mode", () => {
  it("loads follower/following lists from the /api/social list endpoint", () => {
    expect(island).toMatch(/\/api\/social\?list=/);
  });
});

describe("profile page list disclosures", () => {
  it("renders load-list controls anchored to the profile handle", () => {
    expect(profile).toMatch(/data-load-list="followers"/);
    expect(profile).toMatch(/data-load-list="following"/);
  });
});
