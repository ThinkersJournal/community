// SPDX-License-Identifier: MIT OR Apache-2.0
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/auto-rollback.sh against a fake Cloudflare API (design note
 * docs/superpowers/specs/2026-10-25-auto-rollback-design.md). `.node.test.ts`
 * because it spawns real processes. Needs bash, curl and jq: CI's ubuntu-latest has
 * them; where jq is missing the cases skip locally, but fail in CI so the script can
 * never go untested there.
 */

const SCRIPT = join(import.meta.dirname, "../../../scripts/auto-rollback.sh");
const HAVE_TOOLS = ["bash", "curl", "jq"].every(
  (t) => spawnSync(t, ["--version"], { stdio: "ignore" }).status === 0,
);
const CI = process.env.CI === "true";

interface Seen { method: string; path: string; auth: string | undefined; body: string }
type Deployment = { versions: Array<{ version_id: string; percentage: number }> };

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

function single(id: string): Deployment {
  return { versions: [{ version_id: id, percentage: 100 }] };
}

/** A fake API: `deployments[name]` newest first; `refuse` names get a 400 on POST. */
async function fakeApi(deployments: Record<string, Deployment[]>, refuse: string[] = []): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      seen.push({ method: req.method ?? "", path, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      const m = /\/workers\/scripts\/([^/]+)\/deployments$/.exec(path);
      const name = m?.[1] ?? "";
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") {
        res.end(JSON.stringify({ success: true, result: { deployments: deployments[name] ?? [] } }));
      } else if (refuse.includes(name)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, errors: [{ code: 10211, message: "refused" }] }));
      } else {
        res.end(JSON.stringify({ success: true }));
      }
    });
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, seen };
}

function run(base: string, extra: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT], {
    env: { PATH: process.env.PATH ?? "", CLOUDFLARE_API_TOKEN: "tok-secret-value", CLOUDFLARE_ACCOUNT_ID: "acct1", CF_API_BASE: base, ...extra },
    encoding: "utf8",
  });
}

const posts = (seen: Seen[]) => seen.filter((s) => s.method === "POST");

describe.skipIf(!HAVE_TOOLS && !CI)("scripts/auto-rollback.sh", () => {
  it("has its tools in CI (so the cases below can never silently skip there)", () => {
    expect(HAVE_TOOLS || !CI).toBe(true);
  });

  it("rolls api then web back to the previous version, 100%, with the token and a message", async () => {
    const { base, seen } = await fakeApi({
      "thinkersjournal-api": [single("api-new"), single("api-old")],
      "thinkersjournal-web": [single("web-new"), single("web-old")],
    });
    const r = run(base, { GITHUB_SHA: "abc123" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const p = posts(seen);
    expect(p.map((x) => x.path)).toEqual([
      "/accounts/acct1/workers/scripts/thinkersjournal-api/deployments",
      "/accounts/acct1/workers/scripts/thinkersjournal-web/deployments",
    ]);
    expect(JSON.parse(p[0]!.body)).toMatchObject({
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: "api-old" }],
    });
    expect(JSON.parse(p[1]!.body).versions[0].version_id).toBe("web-old");
    expect(JSON.parse(p[0]!.body).annotations["workers/message"]).toContain("abc123");
    expect(p[0]!.auth).toBe("Bearer tok-secret-value");
    // The token never reaches the log.
    expect(r.stdout + r.stderr).not.toContain("tok-secret-value");
  });

  it("DRY_RUN=1 changes nothing", async () => {
    const { base, seen } = await fakeApi({
      "thinkersjournal-api": [single("a2"), single("a1")],
      "thinkersjournal-web": [single("w2"), single("w1")],
    });
    const r = run(base, { DRY_RUN: "1" });
    expect(r.status).toBe(0);
    expect(posts(seen)).toHaveLength(0);
    expect(r.stdout).toContain("would roll back a2 -> a1");
  });

  it("leaves a Worker with no earlier deployment alone, still rolls back the other, and exits 1", async () => {
    const { base, seen } = await fakeApi({
      "thinkersjournal-api": [single("a2"), single("a1")],
      "thinkersjournal-web": [single("only")],
    });
    const r = run(base);
    expect(r.status).toBe(1);
    expect(posts(seen).map((x) => x.path)).toEqual(["/accounts/acct1/workers/scripts/thinkersjournal-api/deployments"]);
    expect(r.stdout).toContain("SKIP thinkersjournal-web");
  });

  it("reports a refusal (a Durable Object lifecycle change) with the API's error, and exits 1", async () => {
    const { base } = await fakeApi(
      { "thinkersjournal-api": [single("a2"), single("a1")], "thinkersjournal-web": [single("w2"), single("w1")] },
      ["thinkersjournal-api"],
    );
    const r = run(base);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAIL thinkersjournal-api");
    expect(r.stdout).toContain("10211");
    // web is still rolled back: one refusal does not strand the other Worker on the bad version.
    expect(r.stdout).toContain("OK   thinkersjournal-web");
  });

  it("does not touch a split (gradual) deployment", async () => {
    const split: Deployment = { versions: [{ version_id: "x", percentage: 50 }, { version_id: "y", percentage: 50 }] };
    const { base, seen } = await fakeApi({
      "thinkersjournal-api": [split, single("a1")],
      "thinkersjournal-web": [single("w2"), single("w1")],
    });
    const r = run(base);
    expect(r.status).toBe(1);
    expect(posts(seen).map((x) => x.path)).toEqual(["/accounts/acct1/workers/scripts/thinkersjournal-web/deployments"]);
  });

  it("refuses to run without its token or account id", async () => {
    const { base } = await fakeApi({});
    const noToken = spawnSync("bash", [SCRIPT], { env: { PATH: process.env.PATH ?? "", CLOUDFLARE_ACCOUNT_ID: "a", CF_API_BASE: base }, encoding: "utf8" });
    expect(noToken.status).not.toBe(0);
    expect(noToken.stderr).toContain("CLOUDFLARE_API_TOKEN");
  });
});
