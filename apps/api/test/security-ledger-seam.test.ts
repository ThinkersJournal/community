// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";

import { crossing, freshLedger, guardAlertingFaults, quiet, T0 } from "./helpers/security-do";

/**
 * #156 — the two TEST_ROUTES-gated seams behind e2e/security-ledger.spec.ts,
 * and the read-only `signalOnsets` RPC the second one calls.
 */
guardAlertingFaults();

const ORIGIN = "http://localhost:8787";

async function call(path: string, init: RequestInit, e: unknown = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test${path}`, init), e as never, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("POST /__test/web-purge-bad-secret", () => {
  it("sends the real header with a wrong secret over WEB and returns web's status", async () => {
    const seen: { url: string; method: string; secret: string | null; configured: boolean }[] = [];
    const WEB = {
      fetch: (url: string, init: RequestInit) => {
        const secret = new Headers(init.headers).get("X-Purge-Secret");
        seen.push({ url, method: String(init.method), secret, configured: secret === env.PURGE_SECRET });
        return Promise.resolve(new Response("{}", { status: 403 }));
      },
    };
    const res = await call("/__test/web-purge-bad-secret", { method: "POST", headers: { Origin: ORIGIN } }, { ...env, WEB });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 403 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "https://web.internal/internal/purge", method: "POST", configured: false });
    expect(seen[0]?.secret).toMatch(/^wrong-/);
  });

  it("403s an origin-less request", async () => {
    expect((await call("/__test/web-purge-bad-secret", { method: "POST" })).status).toBe(403);
  });

  for (const v of [undefined, "0", "true"]) {
    it(`404s when TEST_ROUTES is ${String(v)}`, async () => {
      let called = false;
      const WEB = { fetch: () => ((called = true), Promise.resolve(new Response("{}"))) };
      const res = await call(
        "/__test/web-purge-bad-secret",
        { method: "POST", headers: { Origin: ORIGIN } },
        { ...env, TEST_ROUTES: v, WEB },
      );
      expect(res.status).toBe(404);
      expect(called).toBe(false);
    });
  }
});

describe("GET /__test/security-ledger", () => {
  for (const v of [undefined, "0", "true"]) {
    it(`404s when TEST_ROUTES is ${String(v)}`, async () => {
      expect((await call("/__test/security-ledger", { method: "GET" }, { ...env, TEST_ROUTES: v })).status).toBe(404);
    });
  }

  it("answers 200 with a rows array when the gate is open", async () => {
    const res = await call("/__test/security-ledger", { method: "GET" });
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { rows: unknown }).rows)).toBe(true);
  });
});

describe("SecurityLedgerDO.signalOnsets", () => {
  it("names the onset of a purge crossing with class, day and count, and no subject data", async () => {
    await runInDurableObject(freshLedger(), async (ledger) => {
      quiet(ledger);
      expect(await ledger.signalOnsets()).toEqual([]); // control: an empty ledger reports nothing
      await ledger.reportAt(
        {
          reports: [
            crossing({
              signal: "purge_secret_failure",
              signalClass: "purge",
              subjectKind: "site",
              subject: "site",
              severity: "critical",
              events: 1,
              observed: 1,
              threshold: 1,
              byRoute: { "/internal/purge": 1 },
            }),
          ],
          countedOverflow: {},
        },
        T0,
      );
      const rows = await ledger.signalOnsets();
      expect(rows).toEqual([{ signal: "purge_secret_failure", signalClass: "purge", day: "2026-10-07", sent: 1 }]);
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["day", "sent", "signal", "signalClass"]);
    });
  });
});
