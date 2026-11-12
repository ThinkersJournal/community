// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

/**
 * The GitHub App's identity in config (M3.3; docs/runbooks/register-github-app.md section 4). The App ID is PUBLIC (it is on the
 * app's page and in its install URLs), so it is a plain var in wrangler.jsonc, never a secret. Only the private key is a secret
 * (GITHUB_APP_PRIVATE_KEY, a Worker secret), so it must NOT appear in the file. Read from the real file: the pool's filesystem
 * is virtual (see login-challenge-config.node.test.ts).
 */
interface Config {
  vars?: Record<string, string>;
}
const raw = readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
const api = parse(raw) as Config;

describe("GitHub App config: wrangler.jsonc", () => {
  it("carries the App ID as the plain var GITHUB_APP_ID (CireSnave, 2026-11-12), digits only", () => {
    expect(api.vars?.GITHUB_APP_ID).toBe("5732881");
    expect(api.vars?.GITHUB_APP_ID).toMatch(/^\d+$/);
  });

  it("never carries the private key (a secret belongs in `wrangler secret put`)", () => {
    expect(raw).not.toMatch(/GITHUB_APP_PRIVATE_KEY|BEGIN [A-Z ]*PRIVATE KEY/);
  });
});
