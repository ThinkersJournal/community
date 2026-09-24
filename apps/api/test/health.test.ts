import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";

describe("api worker", () => {
  it("GET /health returns 200", async () => {
    const request = new Request("https://api.test/health");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
  });

  it("unknown path returns 404", async () => {
    const request = new Request("https://api.test/does-not-exist");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  it("GET /health/build reports this Worker's own identity from CF_VERSION_METADATA, no sha field", async () => {
    const request = new Request("https://api.test/health/build");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      worker: string;
      version: { id: string; tag: string; timestamp: string };
      sha?: unknown;
    };
    expect(body.worker).toBe("api");
    // ⚠️ miniflare's local simulation of version_metadata always returns the
    // SAME placeholder id/tag/timestamp (there is no real deploy locally) —
    // this only proves the binding round-trips through the handler, not what
    // a real Workers Builds deploy's values look like.
    expect(typeof body.version.id).toBe("string");
    expect(typeof body.version.tag).toBe("string");
    expect(typeof body.version.timestamp).toBe("string");
    expect(body.sha).toBeUndefined();
  });
});
