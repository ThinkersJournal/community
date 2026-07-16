import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { purgeTags } from "../src/cache/purge";

/**
 * The api half of the purge hop. The `WEB` Service Binding is stubbed here, so
 * what this file pins is the CONTRACT api must honour: one batched call, the
 * right path, the secret, and never throwing.
 *
 * ⚠️ NOTHING HERE OBSERVES A PURGE, AND NO OTHER SUITE DOES EITHER. Be precise
 * about what is and is not proven, because the gaps are not obvious:
 *   • Workers Cache is NOT simulated by miniflare, so no test in this repo can
 *     watch a cache entry disappear. That is deploy-gate-only.
 *   • The REAL cross-Worker dispatch is NOT covered by the E2E today. The suite's
 *     only authoring flow (e2e/signup.spec.ts) posts through `new-post.astro`,
 *     which deliberately sends no `status` and therefore creates a DRAFT — and a
 *     draft purges nothing, correctly. An e2e/publish.spec.ts that publishes
 *     would exercise it; it does not exist yet (T19).
 *   • What HAS been verified live, by hand, against both Workers under
 *     `wrangler dev`: the route is reachable over the dev registry, a wrong or
 *     missing secret 403s, and the correct secret reaches the invalidate call.
 *     See the task report. That is a manual observation, not a regression test.
 */
function stubWeb(response: Response): { fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async () => response);
  return { fetch };
}

afterEach(() => vi.restoreAllMocks());

describe("purgeTags", () => {
  it("sends ONE request carrying ALL tags", async () => {
    const web = stubWeb(new Response(JSON.stringify({ purged: 3 }), { status: 200 }));
    await purgeTags({ ...env, WEB: web } as never, ["post:1", "author:2", "listing"]);

    // ⚠️ ONE call, not three. The Free-zone purge limit is 5 requests per MINUTE
    // (burst 25, 100 ops/request) — a call per tag would spend an author's whole
    // budget in under two edits.
    expect(web.fetch).toHaveBeenCalledTimes(1);
    const [, init] = web.fetch.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      tags: ["post:1", "author:2", "listing"],
    });
  });

  it("dispatches to the purge route web ACTUALLY serves", async () => {
    const web = stubWeb(new Response("{}", { status: 200 }));
    await purgeTags({ ...env, WEB: web } as never, ["x"]);
    // A Service Binding dispatches on the BINDING, so the host is never
    // resolved — but the PATH must match the route web actually serves.
    //
    // ⚠️ `/internal/`, NOT `/__internal/`. The plan said the latter; Astro's router
    // silently SKIPS any file or directory starting with `_`
    // (dist/core/routing/create-manifest.js: `if (name[0] === "_") { continue; }`),
    // so that path 404'd against a real Worker while every unit test stayed green.
    // The other half of this contract is apps/web/src/pages/internal/purge.ts,
    // whose location is pinned by apps/web/test/purge.test.ts.
    expect(String(web.fetch.mock.calls[0]![0])).toBe("https://web.internal/internal/purge");
  });

  it("POSTs (POST bypasses cache, so the purge always executes)", async () => {
    const web = stubWeb(new Response("{}", { status: 200 }));
    await purgeTags({ ...env, WEB: web } as never, ["x"]);
    expect((web.fetch.mock.calls[0]![1] as RequestInit).method).toBe("POST");
  });

  it("sends the shared secret", async () => {
    const web = stubWeb(new Response("{}", { status: 200 }));
    await purgeTags({ ...env, WEB: web, PURGE_SECRET: "s3cret" } as never, ["x"]);
    const headers = new Headers((web.fetch.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("X-Purge-Secret")).toBe("s3cret");
  });

  it("deduplicates tags", async () => {
    const web = stubWeb(new Response("{}", { status: 200 }));
    await purgeTags({ ...env, WEB: web } as never, ["listing", "listing", "post:1"]);
    expect(JSON.parse((web.fetch.mock.calls[0]![1] as RequestInit).body as string).tags).toEqual([
      "listing",
      "post:1",
    ]);
  });

  it("does nothing for an empty tag list", async () => {
    const web = stubWeb(new Response("{}", { status: 200 }));
    await purgeTags({ ...env, WEB: web } as never, []);
    expect(web.fetch).not.toHaveBeenCalled();
  });

  it("NEVER THROWS on a non-2xx — and logs it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const web = stubWeb(new Response("nope", { status: 403 }));
    // ⚠️ A failed purge must never fail the EDIT. The post is already saved.
    await expect(purgeTags({ ...env, WEB: web } as never, ["x"])).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it("NEVER THROWS when the binding itself throws — and logs it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const web = {
      fetch: vi.fn(async () => {
        throw new Error("Network connection lost");
      }),
    };
    await expect(purgeTags({ ...env, WEB: web } as never, ["x"])).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
