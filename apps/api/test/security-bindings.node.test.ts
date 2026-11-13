// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

/**
 * The security-alerting bindings, read from the REAL config files (plan Task 7).
 * A Node test because workerd's filesystem is virtual (vitest.config.ts); the
 * pool would create whatever it is told, so only the source can be pinned.
 */
const API_DIR = join(import.meta.dirname, "..");
const WEB_DIR = join(API_DIR, "../web");

interface DoBinding {
  name: string;
  class_name: string;
  script_name?: string;
}
interface WranglerConfig {
  durable_objects?: { bindings?: DoBinding[] };
  migrations?: { tag: string; new_sqlite_classes?: string[] }[];
  vars?: Record<string, string>;
}

const read = (dir: string): WranglerConfig => parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as WranglerConfig;

describe("api wrangler.jsonc", () => {
  const api = read(API_DIR);

  it("binds both classes", () => {
    expect(api.durable_objects?.bindings).toEqual(
      expect.arrayContaining([
        { name: "SECURITY_COUNTER", class_name: "SecurityCounterDO" },
        { name: "SECURITY_LEDGER", class_name: "SecurityLedgerDO" },
      ]),
    );
  });

  it("adds migration v4 AFTER v3, creating exactly the two classes", () => {
    const tags = api.migrations?.map((m) => m.tag);
    expect(tags?.slice(-3, -1)).toEqual(["v3", "v4"]);
    expect(api.migrations?.find((m) => m.tag === "v4")?.new_sqlite_classes).toEqual(["SecurityCounterDO", "SecurityLedgerDO"]);
  });

  it("adds migration v5 AFTER v4 for the M3.2b author-budget class only (and it is the latest)", () => {
    expect(api.migrations?.at(-1)).toEqual({ tag: "v5", new_sqlite_classes: ["AuthorBudgetDO"] });
  });

  it("ships every flag off but counting and the login challenge (spec §6 phase 1 + S10), and never TEST_ROUTES", () => {
    // LOGIN_CHALLENGE (the login Turnstile challenge) is the fourth flag, ON since S10 (CireSnave 2026-10-25);
    // its own pin is test/login-challenge-config.node.test.ts.
    expect(api.vars).toEqual({
      SECURITY_COUNTING: "on",
      SECURITY_ALERTS_ENABLED: "0",
      ACCOUNT_NOTICES_ENABLED: "0",
      LOGIN_CHALLENGE: "1",
      TERMS_NOTICE: "0", // R12 updated-Terms notice, dark until /terms exists (R1)
      GITHUB_APP_ID: "5732881", // public id; pinned in github-app-config.node.test.ts
      GITLAB_CLIENT_ID: "f0af17837ab96137697c1ff51fbc56a3554c8808b9029865455a106182e1dc25", // public id; pinned in github-app-config.node.test.ts
    });
  });
});

describe("web wrangler.jsonc", () => {
  const web = read(WEB_DIR);

  it("binds SECURITY_COUNTER cross-script to the api's class", () => {
    expect(web.durable_objects?.bindings).toEqual([
      { name: "SECURITY_COUNTER", class_name: "SecurityCounterDO", script_name: "thinkersjournal-api" },
    ]);
  });

  it("declares no migrations of its own (the class lives in the api)", () => {
    expect(web.migrations).toBeUndefined();
  });

  it("has the web half of the kill switch", () => {
    expect(web.vars).toEqual({ SECURITY_COUNTING: "on" });
  });
});
