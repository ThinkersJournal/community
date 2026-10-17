import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { LIVENESS_KEY } from "../src/durable-objects/SecurityLedgerDO";
import { LEDGER_STALE_AFTER_MS } from "../src/routes/health-security-ledger";

/**
 * `GET /health/security-ledger` (security-alerting spec §2.6 R2): one KV read
 * of the liveness key the ledger's alarm writes; `ok` 200 or `stale` 503; a
 * body of exactly `{status}` (no timestamp); never a Durable Object call.
 */
async function fetchWorker(overrideEnv: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://api.test/health/security-ledger"), overrideEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(async () => {
  const { keys } = await env.HEALTH.list();
  await Promise.all(keys.map((k) => env.HEALTH.delete(k.name)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /health/security-ledger", () => {
  it("200 {status:ok} when the liveness key is fresh, and the body carries nothing else", async () => {
    await env.HEALTH.put(LIVENESS_KEY, String(Date.now()));
    const response = await fetchWorker();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"status":"ok"}');
  });

  it("503 {status:stale} when the key was never written", async () => {
    const response = await fetchWorker();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"status":"stale"}');
  });

  it("503 stale when the value is not a number", async () => {
    await env.HEALTH.put(LIVENESS_KEY, "not-a-number");
    const response = await fetchWorker();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"status":"stale"}');
  });

  it("503 stale when the value is older than LEDGER_STALE_AFTER_MS, 200 just inside it", async () => {
    expect(LEDGER_STALE_AFTER_MS).toBe(2 * 3_600_000);
    await env.HEALTH.put(LIVENESS_KEY, String(Date.now() - LEDGER_STALE_AFTER_MS - 1_000));
    expect((await fetchWorker()).status).toBe(503);
    await env.HEALTH.put(LIVENESS_KEY, String(Date.now() - LEDGER_STALE_AFTER_MS + 60_000));
    expect((await fetchWorker()).status).toBe(200);
  });

  it("503 {status:stale} when the KV read itself throws (the ledger cannot be shown alive), never an unhandled 500", async () => {
    const throwing = new Proxy(env, {
      get(target, key, receiver) {
        if (key === "HEALTH") {
          return {
            get: () => Promise.reject(new Error("kv down")),
          };
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const response = await fetchWorker(throwing);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"status":"stale"}');
  });

  it("never touches the SECURITY_LEDGER Durable Object namespace (a public route must not wake it)", async () => {
    await env.HEALTH.put(LIVENESS_KEY, String(Date.now()));
    const touched = vi.fn();
    const guarded = new Proxy(env, {
      get(target, key, receiver) {
        if (key === "SECURITY_LEDGER") touched(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const response = await fetchWorker(guarded);
    expect(response.status).toBe(200);
    expect(touched).not.toHaveBeenCalled();
  });
});
