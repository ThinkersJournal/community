// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGuardedFetch, type FetchLike } from "../src/references/guarded-fetch";

/**
 * M3.10 slice C: every fetch attempt leaves ONE structured `ref_fetch` line (host, outcome, bytes, durationMs) and nothing
 * that identifies the page: no path, query or body text (a path can carry a secret; a card's text is third-party content).
 */
const HTML = { "content-type": "text/html; charset=utf-8" };
const SECRET = "/private/path?token=s3cr3t";

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function refFetchLines(): Array<{ event: string; host: string; outcome: string; bytes: number; durationMs: number }> {
  return lines.filter((l) => l.includes('"ref_fetch"')).map((l) => JSON.parse(l) as never);
}

function guard(fetchImpl: FetchLike, robots = true, maxBytes?: number) {
  return createGuardedFetch({
    fetchImpl,
    resolveHost: async () => ["93.184.216.34"],
    robotsAllowed: async () => robots,
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
}

describe("ref_fetch log line", () => {
  it("an ok fetch logs host, outcome ok, the byte count and a duration, and never the path or query", async () => {
    const body = "<html><title>Hi</title></html>";
    const fetchLive = guard(async () => new Response(body, { status: 200, headers: HTML }));
    await fetchLive(`https://example.com${SECRET}`);
    const out = refFetchLines();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ event: "ref_fetch", host: "example.com", outcome: "ok", bytes: body.length });
    expect(out[0]!.durationMs).toBeGreaterThanOrEqual(0);
    const raw = lines.join("\n");
    expect(raw).not.toContain("s3cr3t");
    expect(raw).not.toContain("/private");
    expect(raw).not.toContain("Hi");
  });

  it("a blocked-by-SSRF target logs outcome blocked_target and the host only, and still rejects", async () => {
    const fetchLive = guard(async () => new Response("never reached"));
    await expect(fetchLive(`http://10.0.0.1${SECRET}`)).rejects.toMatchObject({ code: "blocked_target" });
    const out = refFetchLines();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ host: "10.0.0.1", outcome: "blocked_target", bytes: 0 });
    expect(lines.join("\n")).not.toContain("s3cr3t");
  });

  it("a robots.txt denial is its own outcome", async () => {
    const fetchLive = guard(async () => new Response("never reached"), false);
    await expect(fetchLive("https://example.com/p")).rejects.toMatchObject({ code: "blocked_target" });
    expect(refFetchLines()[0]).toMatchObject({ host: "example.com", outcome: "robots_denied" });
  });

  it("a body over the cap logs too_large", async () => {
    const fetchLive = guard(async () => new Response("x".repeat(100), { status: 200, headers: HTML }), true, 10);
    await expect(fetchLive("https://example.com/big")).rejects.toMatchObject({ code: "too_large" });
    expect(refFetchLines()[0]).toMatchObject({ host: "example.com", outcome: "too_large" });
  });

  it("an unparsable target logs host invalid and does not echo the text", async () => {
    const fetchLive = guard(async () => new Response("never reached"));
    await expect(fetchLive("not a url s3cr3t")).rejects.toBeDefined();
    expect(refFetchLines()[0]).toMatchObject({ host: "invalid" });
    expect(lines.join("\n")).not.toContain("s3cr3t");
  });
});
