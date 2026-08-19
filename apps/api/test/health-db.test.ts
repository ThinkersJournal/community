import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src";
import { PROBE_KEY, RECENT_WINDOW, STALE_AFTER_MS, readDbProbe, recordDbProbe } from "../src/health/probe";

import type { DbProbeRecord, DbProbeState } from "../src/health/probe";

/**
 * db-health-probe — detection half only (no notifier here). Covers:
 *   • recordDbProbe against the real test DB (success + accumulation + cap).
 *   • recordDbProbe's two never-throw paths: a DB failure, and a KV-write
 *     failure.
 *   • GET /health/db reading back what recordDbProbe wrote — unknown/ok/
 *     stale/down, and the TEST_ROUTES-gated detail fields.
 *
 * Runs in the POOL project (real workerd): real `HEALTH` KV, real Postgres
 * via `HYPERDRIVE_FRESH`.
 */

/** Drive the Worker through a full request lifecycle. */
async function fetchWorker(request: Request, overrideEnv: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, overrideEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** A Hyperdrive binding whose connection always fails fast (loopback, refused). */
function unreachableHyperdrive(): Hyperdrive {
  return {
    connectionString: "postgres://baduser:badpass@127.0.0.1:59999/nonexistent_db",
  } as unknown as Hyperdrive;
}

beforeEach(async () => {
  // Isolate HEALTH across tests within this pool file (isolatedStorage was
  // removed, so KV contents persist across tests otherwise) — same pattern
  // as test/csrf-route.test.ts's SESSIONS cleanup.
  const { keys } = await env.HEALTH.list();
  await Promise.all(keys.map((k) => env.HEALTH.delete(k.name)));
});

afterEach(() => {
  // Restore any console.error spy so an expected log line does not pollute
  // sibling test output.
  vi.restoreAllMocks();
});

describe("recordDbProbe", () => {
  it("a successful probe records ok:true, lastCheckAt set, one recent entry", async () => {
    const ctx = createExecutionContext();
    await recordDbProbe(env, ctx);
    await waitOnExecutionContext(ctx);

    const state = await readDbProbe(env);
    expect(state).not.toBeNull();
    expect(state?.ok).toBe(true);
    expect(state?.error).toBeUndefined();
    expect(state?.lastCheckAt).toBeGreaterThan(0);
    expect(typeof state?.latencyMs).toBe("number");
    expect(state?.recent).toHaveLength(1);
    expect(state?.recent[0]).toMatchObject({ ok: true });
  });

  it("multiple probes accumulate, most-recent-first", async () => {
    for (let i = 0; i < 3; i++) {
      const ctx = createExecutionContext();
      await recordDbProbe(env, ctx);
      await waitOnExecutionContext(ctx);
    }

    const state = await readDbProbe(env);
    expect(state?.recent).toHaveLength(3);
    const ats = state!.recent.map((r) => r.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
  });

  it("caps recent at RECENT_WINDOW even when more history already exists", async () => {
    const seeded: DbProbeRecord[] = Array.from({ length: RECENT_WINDOW + 10 }, (_, i) => ({
      at: Date.now() - i * 1_000,
      ok: true,
      latencyMs: 1,
    }));
    const seededState: DbProbeState = {
      lastCheckAt: Date.now() - 100_000,
      ok: true,
      latencyMs: 1,
      recent: seeded,
    };
    await env.HEALTH.put(PROBE_KEY, JSON.stringify(seededState));

    const ctx = createExecutionContext();
    await recordDbProbe(env, ctx);
    await waitOnExecutionContext(ctx);

    const state = await readDbProbe(env);
    expect(state?.recent.length).toBe(RECENT_WINDOW);
    // The cap keeps the FRESHEST entries — the just-recorded probe survives.
    expect(state?.recent[0]?.at).toBeGreaterThan(seeded[0]!.at);
  });

  it("DB-failure path: a broken Hyperdrive connection records ok:false with a stored error and resolves rather than throwing", async () => {
    const ctx = createExecutionContext();
    const failingEnv = { ...env, HYPERDRIVE_FRESH: unreachableHyperdrive() } as unknown as Env;

    await expect(recordDbProbe(failingEnv, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);

    const state = await readDbProbe(env);
    expect(state?.ok).toBe(false);
    expect(typeof state?.error).toBe("string");
    expect(state?.error?.length).toBeGreaterThan(0);
    expect(state?.recent[0]).toMatchObject({ ok: false });
  });

  it("KV-write-failure path: a rejecting env.HEALTH.put does not throw — the failure is only logged", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createExecutionContext();
    const failingPutEnv = {
      ...env,
      HEALTH: {
        get: env.HEALTH.get.bind(env.HEALTH),
        put: async () => {
          throw new Error("KV put failed");
        },
      },
    } as unknown as Env;

    await expect(recordDbProbe(failingPutEnv, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);

    expect(errorSpy).toHaveBeenCalledWith("db-probe: KV write failed", expect.any(Error));
    // The freeze this failure causes: nothing was ever written for this key.
    expect(await readDbProbe(env)).toBeNull();
  });
});

describe("GET /health/db", () => {
  it("503s status:unknown when no probe has ever run", async () => {
    const response = await fetchWorker(new Request("https://api.test/health/db"));

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "unknown",
      lastCheckAt: null,
      ageMs: null,
      staleAfterMs: STALE_AFTER_MS,
    });
  });

  it("200s status:ok with the bare body after a good probe — no error/recent/latencyMs when TEST_ROUTES isn't \"1\"", async () => {
    const ctx = createExecutionContext();
    await recordDbProbe(env, ctx);
    await waitOnExecutionContext(ctx);

    // The pool sets TEST_ROUTES="1" via miniflare.bindings; simulate
    // production (where the var is absent) the same way
    // test/email-verify.test.ts does for its own TEST_ROUTES-gated route.
    const prodEnv = { ...env, TEST_ROUTES: undefined } as unknown as Env;
    const response = await fetchWorker(new Request("https://api.test/health/db"), prodEnv);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", staleAfterMs: STALE_AFTER_MS });
    expect(typeof body.lastCheckAt).toBe("number");
    expect(typeof body.ageMs).toBe("number");
    expect(body).not.toHaveProperty("error");
    expect(body).not.toHaveProperty("recent");
    expect(body).not.toHaveProperty("latencyMs");
  });

  it("with TEST_ROUTES=\"1\" the detail fields (error, latencyMs, recent) appear", async () => {
    const ctx = createExecutionContext();
    await recordDbProbe(env, ctx);
    await waitOnExecutionContext(ctx);

    // `env` already carries TEST_ROUTES="1" in this pool (vitest.config.ts).
    const response = await fetchWorker(new Request("https://api.test/health/db"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("error", null);
    expect(typeof body.latencyMs).toBe("number");
    expect(Array.isArray(body.recent)).toBe(true);
    expect((body.recent as unknown[]).length).toBe(1);
  });

  it("503s status:stale when the last probe is older than STALE_AFTER_MS", async () => {
    const staleAt = Date.now() - (STALE_AFTER_MS + 60_000);
    const staleState: DbProbeState = {
      lastCheckAt: staleAt,
      ok: true,
      latencyMs: 5,
      recent: [{ at: staleAt, ok: true, latencyMs: 5 }],
    };
    await env.HEALTH.put(PROBE_KEY, JSON.stringify(staleState));

    const response = await fetchWorker(new Request("https://api.test/health/db"));

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "stale", checkedRecently: false, lastCheckAt: staleAt });
  });

  it("503s status:down when the last recorded probe failed", async () => {
    const ctx = createExecutionContext();
    const failingEnv = { ...env, HYPERDRIVE_FRESH: unreachableHyperdrive() } as unknown as Env;
    await recordDbProbe(failingEnv, ctx);
    await waitOnExecutionContext(ctx);

    const response = await fetchWorker(new Request("https://api.test/health/db"));

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    // Recent (not stale), just failed — checkedRecently reflects staleness,
    // not health.
    expect(body).toMatchObject({ status: "down", checkedRecently: true });
  });
});
