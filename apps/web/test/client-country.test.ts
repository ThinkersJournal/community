import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CLIENT_COUNTRY_HEADER } from "@thinkersjournal/shared";

import { applyClientCountryHeader, clientIpStore, edgeCountry, runWithClientIp } from "../src/lib/client-ip-store";

/**
 * `X-TJ-Client-Country` (security-alerting spec §4.2): the same
 * overwrite, delete and enumeration cases as test/client-ip-store.test.ts has
 * for the IP header.
 */
describe("edgeCountry / runWithClientIp", () => {
  it("seeds the store with the edge's country for the life of `next`", () => {
    const request = new Request("https://x.test/", { headers: { "CF-IPCountry": "DE", "CF-Connecting-IP": "203.0.113.9" } });
    expect(runWithClientIp(request, () => clientIpStore.getStore()?.clientCountry)).toBe("DE");
  });

  it("prefers request.cf.country to the CF-IPCountry header", () => {
    const request = Object.assign(new Request("https://x.test/", { headers: { "CF-IPCountry": "DE" } }), { cf: { country: "FR" } });
    expect(edgeCountry(request)).toBe("FR");
  });

  it.each([null, "de", "DEU", "203.0.113.9", "XX1"])("%j is not a country → null", (value) => {
    const headers: Record<string, string> = value === null ? {} : { "CF-IPCountry": value };
    expect(edgeCountry(new Request("https://x.test/", { headers }))).toBeNull();
  });
});

describe("applyClientCountryHeader", () => {
  it("sets the header", () => {
    const h = new Headers();
    applyClientCountryHeader(h, "FR");
    expect(h.get(CLIENT_COUNTRY_HEADER)).toBe("FR");
  });

  it("overrides a pre-existing value rather than leaving it", () => {
    const h = new Headers({ [CLIENT_COUNTRY_HEADER]: "ZZ" });
    applyClientCountryHeader(h, "FR");
    expect(h.get(CLIENT_COUNTRY_HEADER)).toBe("FR");
  });

  it("removes a pre-existing value when the country is null — never a stale or attacker value", () => {
    const h = new Headers({ [CLIENT_COUNTRY_HEADER]: "ZZ" });
    applyClientCountryHeader(h, null);
    expect(h.has(CLIENT_COUNTRY_HEADER)).toBe(false);
  });
});

describe("every API.fetch call site in apps/web/src applies applyClientCountryHeader", () => {
  // Enumerated from the INDEX (`git ls-files`), never by walking the disk: a disk
  // walk sees other checkouts' files (portfolio CLAUDE.md §5b).
  const ROOT = join(import.meta.dirname, "../../..");
  const sites = execFileSync("git", ["ls-files", "apps/web/src"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts") || f.endsWith(".astro"))
    .map((f) => join(ROOT, f))
    .filter((file) => /^\s*[^/*\s].*API\.fetch\(/m.test(readFileSync(file, "utf8")));

  it("finds the five real call sites (positive control)", () => {
    expect(sites.length).toBe(5);
  });

  it.each(sites)("%s applies the country header beside the IP header", (file) => {
    const code = readFileSync(file, "utf8");
    expect(code).toMatch(/applyClientCountryHeader\(\w+, clientIpStore\.getStore\(\)\?\.clientCountry \?\? null\)/);
  });
});
