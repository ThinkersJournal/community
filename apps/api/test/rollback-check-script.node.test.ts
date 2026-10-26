// SPDX-License-Identifier: MIT OR Apache-2.0
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/rollback-check.sh (board 305) against a fake Cloudflare API. Its promise: it
 * only READS (GET), never prints the token, and exits 0 only when the token verifies and
 * both production Workers' deployments can be read. Needs bash, curl and jq: ubuntu-latest
 * has them; the cases skip locally without them and fail in CI if they are missing.
 */

const SCRIPT = join(import.meta.dirname, "../../../scripts/rollback-check.sh");
const HAVE_TOOLS = ["bash", "curl", "jq"].every((t) => spawnSync(t, ["--version"], { stdio: "ignore" }).status === 0);
const CI = process.env.CI === "true";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

interface Opts { noVerify?: boolean; deploymentsStatus?: Record<string, number>; accountVerifyOnly?: boolean }

async function fakeApi(o: Opts = {}): Promise<{ base: string; seen: Array<{ method: string; path: string }> }> {
  const seen: Array<{ method: string; path: string }> = [];
  server = createServer((req, res) => {
    const path = req.url ?? "";
    seen.push({ method: req.method ?? "", path });
    res.setHeader("content-type", "application/json");
    const send = (status: number, body: unknown) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    if (path === "/user/tokens/verify") {
      if (o.accountVerifyOnly) return send(403, { success: false, errors: [{ code: 1000, message: "not a user token" }] });
      if (o.noVerify) return send(401, { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] });
      return send(200, { success: true, result: { status: "active" } });
    }
    if (path === "/accounts/acct1/tokens/verify") {
      if (o.noVerify) return send(401, { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] });
      return send(200, { success: true, result: { status: "active" } });
    }
    if (path === "/accounts/acct1/workers/scripts") {
      return send(200, { success: true, result: [{ id: "thinkersjournal-web" }, { id: "thinkersjournal-api" }] });
    }
    const m = /\/workers\/scripts\/([^/]+)\/deployments$/.exec(path);
    if (m) {
      const status = o.deploymentsStatus?.[m[1]!] ?? 200;
      if (status !== 200) return send(status, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
      return send(200, { success: true, result: { deployments: [{ id: "d1" }, { id: "d2" }] } });
    }
    return send(404, { success: false });
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

function run(base: string) {
  return spawnSync("bash", [SCRIPT], {
    env: { PATH: process.env.PATH ?? "", CLOUDFLARE_API_TOKEN: "tok-secret-value", CLOUDFLARE_ACCOUNT_ID: "acct1", CF_API_BASE: base },
    encoding: "utf8",
  });
}

describe.skipIf(!HAVE_TOOLS && !CI)("scripts/rollback-check.sh", () => {
  it("passes when the token verifies and both Workers' deployments are readable; GET only; never prints the token", async () => {
    const { base, seen } = await fakeApi();
    const r = run(base);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(r.stdout).toContain("thinkersjournal-api, thinkersjournal-web");
    expect(r.stdout).toContain("RESULT: the token works");
    expect(r.stdout + r.stderr).not.toContain("tok-secret-value");
  });

  it("falls back to the account verify endpoint for an account-owned token", async () => {
    const { base, seen } = await fakeApi({ accountVerifyOnly: true });
    const r = run(base);
    expect(r.status, r.stdout).toBe(0);
    expect(seen.some((s) => s.path === "/accounts/acct1/tokens/verify")).toBe(true);
  });

  it("fails (exit 1) when the token does not verify as active at either endpoint", async () => {
    const { base } = await fakeApi({ noVerify: true });
    const r = run(base);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAIL token did not verify");
    expect(r.stdout).toContain("RESULT: NOT ready");
  });

  it("fails when a production Worker's deployments cannot be read (the read the rollback needs)", async () => {
    const { base } = await fakeApi({ deploymentsStatus: { "thinkersjournal-web": 403 } });
    const r = run(base);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAIL thinkersjournal-web");
    expect(r.stdout).toContain("RESULT: NOT ready");
  });
});
