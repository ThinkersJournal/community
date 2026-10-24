// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

/**
 * The login challenge's configuration, read from the REAL wrangler files (a Node
 * test for the reason test/security-bindings.node.test.ts gives: the pool's
 * filesystem is virtual).
 *
 * Pinned here because every value is a decision CireSnave made (2026-10-11,
 * "1) A 2) Fail closed 3) Accept 4) flag-gated so we have the option to turn it
 * off in emergency situations."): the soft thresholds are 3 / 3 / 15 per 60 s, and
 * the flag ships OFF. A namespace id is unique across the whole Cloudflare
 * ACCOUNT, so uniqueness is checked across BOTH Workers' files.
 */
interface Limiter {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
}
interface Config {
  ratelimits?: Limiter[];
  vars?: Record<string, string>;
}

const API_DIR = join(import.meta.dirname, "..");
const read = (dir: string): Config => parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as Config;
const api = read(API_DIR);
const web = read(join(API_DIR, "../web"));
const byName = (name: string) => api.ratelimits?.find((l) => l.name === name);

describe("login challenge: wrangler.jsonc", () => {
  it("ships the flag OFF, as the string \"0\" (anything but \"1\" is off)", () => {
    expect(api.vars?.LOGIN_CHALLENGE).toBe("0");
  });

  it("binds the soft limiters at 3/60s (ip:email and email) and 15/60s (ip)", () => {
    expect(byName("LOGIN_CHALLENGE_LIMITER")?.simple).toEqual({ limit: 3, period: 60 });
    expect(byName("LOGIN_CHALLENGE_IP_LIMITER")?.simple).toEqual({ limit: 15, period: 60 });
  });

  it("leaves the three hard caps exactly where they were (30 ip-only, 10 and 10 on LOGIN_LIMITER)", () => {
    expect(byName("LOGIN_IP_LIMITER")?.simple).toEqual({ limit: 30, period: 60 });
    expect(byName("LOGIN_LIMITER")?.simple).toEqual({ limit: 10, period: 60 });
  });

  it("gives every ratelimit binding in the account a unique namespace_id", () => {
    const all = [...(api.ratelimits ?? []), ...(web.ratelimits ?? [])];
    // Anti-vacuity: both new bindings are among the ones compared.
    expect(all.map((l) => l.name)).toEqual(expect.arrayContaining(["LOGIN_CHALLENGE_LIMITER", "LOGIN_CHALLENGE_IP_LIMITER", "PURGE_LIMITER"]));
    const ids = all.map((l) => l.namespace_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
