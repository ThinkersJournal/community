// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "@playwright/test";

import { LEDGER_API_URL, LEDGER_ORIGIN } from "../playwright.config";

/**
 * #156 — the security ledger's purge path, across the Worker boundary the
 * two-process harness cannot cross.
 *
 * WHAT IT PROVES: a FAILED `/internal/purge` on the `web` Worker is counted by
 * web (apps/web/src/lib/security-counting.ts), reaches `SecurityCounterDO` on the
 * api through web's cross-script DO binding, crosses its threshold (rule
 * `purge_secret_failure`, threshold 1), and its alarm reports it to
 * `SecurityLedgerDO`. Runs ONLY in the `ledger` Playwright project, a
 * single `wrangler dev -c api -c web` process, because that cross-script DO call
 * fails ("Network connection lost") between two separate dev processes.
 *
 * NOTHING IS ADDED TO web. The api is the primary worker (it owns the port); web
 * is auxiliary and unreachable from here. `POST /__test/web-purge-bad-secret`
 * (TEST_ROUTES-gated, api) calls web's purge route over the existing WEB service
 * binding with a wrong secret; `GET /__test/security-ledger` reads the ledger.
 *
 * ⚠️ ONE failed attempt only: failed attempts spend web's PURGE_LIMITER.
 * ⚠️ Asserts CONTAINS, never exact counts: the ledger is a shared singleton and
 * the rule has a 10-minute window.
 */
test("a failed web purge is counted and reaches the security ledger", async ({ request }) => {
  const attempt = await request.post(`${LEDGER_API_URL}/__test/web-purge-bad-secret`, {
    headers: { Origin: LEDGER_ORIGIN },
  });
  expect(attempt.status(), "seam must answer 200 — is TEST_ROUTES=1 set on the ledger api?").toBe(200);
  expect(await attempt.json(), "web must refuse a wrong purge secret with 403").toEqual({ status: 403 });

  // web buffers 5 s before flushing to the counter; the counter alarms, then reports.
  await expect
    .poll(
      async () => {
        const res = await request.get(`${LEDGER_API_URL}/__test/security-ledger`);
        if (res.status() !== 200) return [`status ${res.status()}`];
        const body = (await res.json()) as { rows: { signal: string }[] };
        return body.rows.map((r) => r.signal);
      },
      { timeout: 45_000, intervals: [1_000, 2_000, 3_000], message: "ledger never recorded purge_secret_failure" },
    )
    .toContain("purge_secret_failure");
});
