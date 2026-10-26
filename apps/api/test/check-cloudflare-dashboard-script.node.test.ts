// SPDX-License-Identifier: MIT OR Apache-2.0
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/check-cloudflare-dashboard.sh (S3) against a fake Cloudflare API. Its promises:
 * GET only, the token only from the environment and never printed, and "unknown" (never a
 * guess) for what the token cannot see. Needs bash, curl, jq (ubuntu-latest has them; the
 * behavioural cases skip locally without them and fail in CI if they are missing).
 */

const PATH = join(import.meta.dirname, "../../../scripts/check-cloudflare-dashboard.sh");
const HAVE_TOOLS = ["bash", "curl", "jq"].every((t) => spawnSync(t, ["--version"], { stdio: "ignore" }).status === 0);
const CI = process.env.CI === "true";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

type Rules = Record<string, unknown[] | number>; // phase -> rules, or an HTTP status to answer

async function fakeApi(o: { phases?: Rules; csam?: unknown | number; policies?: unknown[] | number; web?: boolean; api?: boolean }) {
  const seen: Array<{ method: string; path: string }> = [];
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    seen.push({ method: req.method ?? "", path });
    res.setHeader("content-type", "application/json");
    const send = (st: number, body: unknown) => { res.statusCode = st; res.end(JSON.stringify(body)); };
    if (path === "/zones") return send(200, { success: true, result: [{ id: "z1", account: { id: "a1" } }] });
    let m = /^\/zones\/z1\/rulesets\/phases\/([^/]+)\/entrypoint$/.exec(path);
    if (m) {
      const v = o.phases?.[m[1]!];
      if (typeof v === "number") return send(v, { success: false, errors: [{ code: 10000 }] });
      if (v === undefined) return send(404, { success: false });
      return send(200, { success: true, result: { rules: v } });
    }
    if (path === "/zones/z1/settings/csam_scanner_third_party") {
      if (typeof o.csam === "number") return send(o.csam, { success: false, errors: [{ code: 9109 }] });
      return send(200, { success: true, result: o.csam ?? { enabled: true } });
    }
    if (path === "/accounts/a1/alerting/v3/policies") {
      if (typeof o.policies === "number") return send(o.policies, { success: false, errors: [] });
      return send(200, { success: true, result: o.policies ?? [] });
    }
    m = /^\/accounts\/a1\/workers\/scripts\/([^/]+)\/subdomain$/.exec(path);
    if (m) return send(200, { success: true, result: { enabled: m[1] === "thinkersjournal-web" ? (o.web ?? false) : (o.api ?? true) } });
    return send(404, { success: false });
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

const run = (base: string) =>
  spawnSync("bash", [PATH], { env: { PATH: process.env.PATH ?? "", CLOUDFLARE_API_TOKEN: "tok-secret-value", CF_API_BASE: base }, encoding: "utf8" });

const FULL: Rules = {
  http_request_firewall_custom: [{ enabled: true, action: "block", description: "block internal", expression: '(starts_with(http.request.uri.path, "/internal/"))' }],
  http_ratelimit: [{ enabled: true, description: "public reads", expression: '(http.request.uri.path wildcard "/public/*")', ratelimit: { period: 60 } }],
  http_request_cache_settings: [{ enabled: true, description: "cdn", expression: '(http.host eq "cdn.thinkersjournal.com")', action_parameters: { cache: true } }],
  http_response_headers_transform: [{ enabled: true, description: "nosniff", expression: "true", action_parameters: { headers: { "X-Content-Type-Options": { operation: "set", value: "nosniff" } } } }],
};

describe("scripts/check-cloudflare-dashboard.sh: static promises", () => {
  const text = readFileSync(PATH, "utf8");
  const code = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  it("reads the token from the environment only and makes no write request", () => {
    expect(text).toContain('"${CLOUDFLARE_API_TOKEN:?');
    expect(code.find((l) => /curl[^\n]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s)/.test(l))).toBeUndefined();
    expect(code.find((l) => /(echo|printf)[^\n]*\$CLOUDFLARE_API_TOKEN/.test(l))).toBeUndefined();
  });
});

describe.skipIf(!HAVE_TOOLS && !CI)("scripts/check-cloudflare-dashboard.sh against a fake API", () => {
  it("reports every item PRESENT when it is configured; GET only; never prints the token", async () => {
    const { base, seen } = await fakeApi({
      phases: FULL,
      csam: { enabled: true },
      policies: [{ name: "Postmark send failures" }, { name: "Purge log alert" }],
      web: false,
    });
    const r = run(base);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const item of ["WAF block on /internal/*", "WAF rate limit on public reads", "CDN cache rule", "nosniff transform rule", "CSAM Scanning Tool", "postmark log alert", "purge log alert", "workers.dev off on the web Worker"]) {
      expect(r.stdout, item).toMatch(new RegExp(`PRESENT\\s+${item.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
    }
    expect(r.stdout).toContain("PRESENT: 8   ABSENT: 0   UNKNOWN: 0");
    expect(r.stdout).toContain("INFO     workers.dev on the api Worker is true");
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(r.stdout + r.stderr).not.toContain("tok-secret-value");
  });

  it("reports ABSENT for what is missing or off", async () => {
    const { base } = await fakeApi({ phases: {}, csam: { enabled: false }, policies: [], web: true });
    const r = run(base);
    expect(r.stdout).toMatch(/ABSENT\s+WAF block on \/internal\/\*/);
    expect(r.stdout).toMatch(/ABSENT\s+CSAM Scanning Tool/);
    expect(r.stdout).toMatch(/ABSENT\s+workers\.dev off on the web Worker/);
    expect(r.stdout).toMatch(/ABSENT\s+postmark log alert/);
  });

  it("reports UNKNOWN, with the status, for what the token cannot see, and never guesses", async () => {
    const { base } = await fakeApi({
      phases: { http_request_firewall_custom: 403, http_ratelimit: 403, http_request_cache_settings: FULL.http_request_cache_settings!, http_response_headers_transform: 403 },
      csam: 403,
      policies: 403,
    });
    const r = run(base);
    expect(r.stdout).toMatch(/UNKNOWN\s+WAF block on \/internal\/\*: the token cannot read this ruleset \(403\)/);
    expect(r.stdout).toMatch(/UNKNOWN\s+CSAM Scanning Tool: the token cannot read the setting \(403\)/);
    expect(r.stdout).toMatch(/UNKNOWN\s+Postmark\/purge log alerts/);
    expect(r.stdout).toMatch(/PRESENT\s+CDN cache rule/);
  });

  it("a rule that is disabled or the wrong shape is not PRESENT", async () => {
    const phases: Rules = {
      ...FULL,
      http_request_firewall_custom: [{ enabled: false, action: "block", expression: '(starts_with(http.request.uri.path, "/internal/"))' }],
      http_response_headers_transform: [{ enabled: true, expression: "true", action_parameters: { headers: { "X-Content-Type-Options": { value: "other" } } } }],
    };
    const { base } = await fakeApi({ phases, csam: { enabled: true }, policies: [] });
    const r = run(base);
    expect(r.stdout).toMatch(/ABSENT\s+WAF block on \/internal\/\*/);
    expect(r.stdout).toMatch(/ABSENT\s+nosniff transform rule/);
  });
});
