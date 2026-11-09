// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.1b: the per-origin fetch rate limit deferred from M3.1a (spec 5 rule 6), as a wrapper over the guarded door.
import { ConnectorError, type FetchCtx, type FetchedPage } from "@thinkersjournal/shared";
import { describe, expect, it } from "vitest";

import { OriginRateLimitedError, withOriginLimit, type LimiterLike } from "../src/references/origin-limit";

const PAGE: FetchedPage = { status: 200, finalUrl: "https://a.example.com/", contentType: "text/html", headers: {}, body: "", truncated: false };

/** A fixed-window counter keyed like the Workers binding: `limit` successes per key, then refusals. */
function counter(limit: number): LimiterLike & { keys: string[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}
function inner(): { fetch: FetchCtx["fetch"]; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(String(url));
      return PAGE;
    },
  };
}

describe("withOriginLimit", () => {
  it("passes calls through until the origin's quota is spent, then refuses", async () => {
    const door = inner();
    const f = withOriginLimit(door.fetch, counter(2));
    await f("https://a.example.com/1");
    await f("https://a.example.com/2");
    const err = await f("https://a.example.com/3").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OriginRateLimitedError);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).retryable).toBe(true);
  });

  // Mutation that must fail: call the inner fetch before (or despite) the limiter's refusal.
  it("a refused call never reaches the network", async () => {
    const door = inner();
    const f = withOriginLimit(door.fetch, counter(1));
    await f("https://a.example.com/1");
    await f("https://a.example.com/2").catch(() => undefined);
    expect(door.calls).toEqual(["https://a.example.com/1"]);
  });

  // Mutation that must fail: one shared key for every origin.
  it("each origin has its own quota", async () => {
    const f = withOriginLimit(inner().fetch, counter(1));
    await f("https://a.example.com/1");
    await expect(f("https://b.example.com/1")).resolves.toBeDefined();
    await expect(f("https://a.example.com/2")).rejects.toBeInstanceOf(OriginRateLimitedError);
  });

  it("the key is the host only: path, query and case do not make a new origin", async () => {
    const limiter = counter(100);
    const f = withOriginLimit(inner().fetch, limiter);
    await f("https://A.Example.com/x?y=1#z");
    await f("https://a.example.com/other");
    expect(new Set(limiter.keys).size).toBe(1);
    expect(limiter.keys[0]).toContain("a.example.com");
    expect(limiter.keys[0]).not.toContain("/x");
  });

  it("a URL that does not parse is a ConnectorError, not a TypeError", async () => {
    const err = await withOriginLimit(inner().fetch, counter(1))("not a url").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe("invalid_url");
  });
});
