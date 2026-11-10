// SPDX-License-Identifier: MIT OR Apache-2.0
import { ConnectorError, type FetchedPage } from "@thinkersjournal/shared";
import { describe, expect, it } from "vitest";

import {
  BOT_USER_AGENT,
  createDohResolver,
  createGuardedFetch,
  GUARD_DEFAULTS,
  isAllowedByRobots,
  type FetchLike,
  type GuardedFetchOptions,
} from "../src/references/guarded-fetch";

const PUBLIC_IP = "93.184.216.34";
const HTML = { "content-type": "text/html; charset=utf-8" };

function page(body: string, headers: Record<string, string> = HTML, status = 200): Response {
  return new Response(body, { status, headers });
}
function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

interface Recorder {
  calls: Array<{ url: string; init: RequestInit }>;
  fetchImpl: FetchLike;
}
function recorder(handler: (url: string, n: number) => Response | Promise<Response>): Recorder {
  const calls: Recorder["calls"] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, calls.length);
    },
  };
}

function guard(rec: Recorder, extra: Partial<GuardedFetchOptions> = {}) {
  return createGuardedFetch({
    fetchImpl: rec.fetchImpl,
    resolveHost: async () => [PUBLIC_IP],
    robotsAllowed: async () => true,
    ...extra,
  });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConnectorError) return e.code;
    throw e;
  }
  return "no-throw";
}

describe("guarded fetch: the happy path and headers", () => {
  it("fetches with GET, redirect manual, the bot User-Agent, and returns the page", async () => {
    const rec = recorder(() => page("<title>Hi</title>", { ...HTML, etag: '"abc"' }));
    const got: FetchedPage = await guard(rec)("https://example.com/a");
    expect(got.status).toBe(200);
    expect(got.finalUrl).toBe("https://example.com/a");
    expect(got.body).toBe("<title>Hi</title>");
    expect(got.truncated).toBe(false);
    expect(got.headers.etag).toBe('"abc"');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.init.method).toBe("GET");
    expect(rec.calls[0]?.init.redirect).toBe("manual");
  });

  // Mutation that must fail this: send a different/missing User-Agent.
  it("sends exactly the documented User-Agent and a caller cannot override it", async () => {
    expect(BOT_USER_AGENT).toBe("ThinkersJournalBot/1.0 (+https://community.thinkersjournal.com/bot)");
    const rec = recorder(() => page("x"));
    await guard(rec)("https://example.com/", { headers: { "User-Agent": "evil", "If-None-Match": '"e"' } });
    const h = new Headers(rec.calls[0]?.init.headers);
    expect(h.get("user-agent")).toBe(BOT_USER_AGENT);
    expect(h.get("if-none-match")).toBe('"e"');
  });

  // Mutation that must fail this: change a default (timeout 5s, 512 KB, 3 redirects).
  it("carries the contract's defaults", () => {
    expect(GUARD_DEFAULTS).toEqual({ timeoutMs: 5000, maxBytes: 512 * 1024, maxRedirects: 3 });
  });

  it("refuses a blocked first URL without touching the network", async () => {
    const rec = recorder(() => page("x"));
    expect(await codeOf(guard(rec)("http://169.254.169.254/latest/meta-data"))).toBe("blocked_target");
    expect(rec.calls).toHaveLength(0);
  });
});

describe("guarded fetch: redirects", () => {
  // Mutation that must fail this: validate only the first URL.
  it.each(["http://169.254.169.254/latest", "http://127.0.0.1:8080/admin", "http://[::1]/", "http://localhost/"])(
    "refuses a redirect to %s at the hop, before connecting",
    async (target) => {
      const rec = recorder((url) => (url === "https://example.com/" ? redirect(target) : page("secret")));
      expect(await codeOf(guard(rec)("https://example.com/"))).toBe("blocked_target");
      expect(rec.calls.map((c) => c.url)).toEqual(["https://example.com/"]);
    },
  );

  it("refuses a redirect to a name whose DNS answer is private", async () => {
    const rec = recorder((url) => (url === "https://example.com/" ? redirect("https://rebind.test/") : page("secret")));
    const resolveHost = async (host: string) => (host === "rebind.test" ? ["10.0.0.5"] : [PUBLIC_IP]);
    expect(await codeOf(guard(rec, { resolveHost })("https://example.com/"))).toBe("blocked_target");
    expect(rec.calls).toHaveLength(1);
  });

  // Mutation that must fail this: raise maxRedirects, or count from 1.
  it("follows 3 redirects (relative Location included) and returns the final page", async () => {
    const rec = recorder((_url, n) => (n === 1 ? redirect("/b") : n === 2 ? redirect("https://example.com/c", 301) : n === 3 ? redirect("d", 307) : page("done")));
    const got = await guard(rec)("https://example.com/a");
    expect(got.body).toBe("done");
    expect(got.finalUrl).toBe("https://example.com/d");
    expect(rec.calls.map((c) => c.url)).toEqual([
      "https://example.com/a", "https://example.com/b", "https://example.com/c", "https://example.com/d",
    ]);
  });

  it("refuses the 4th redirect and makes no 5th request", async () => {
    const rec = recorder((_url, n) => redirect(`/hop${n}`));
    expect(await codeOf(guard(rec)("https://example.com/"))).not.toBe("no-throw");
    expect(rec.calls).toHaveLength(4);
  });

  it("refuses a redirect with no Location", async () => {
    const rec = recorder(() => new Response(null, { status: 302 }));
    expect(await codeOf(guard(rec)("https://example.com/"))).toBe("upstream");
  });

  // Mutation that must fail this: drop the downgrade check.
  it("refuses an https to http downgrade, but allows http to https", async () => {
    const down = recorder((url) => (url.startsWith("https://") ? redirect("http://other.example.org/") : page("x")));
    expect(await codeOf(guard(down)("https://example.com/"))).toBe("blocked_target");
    expect(down.calls).toHaveLength(1);

    const up = recorder((url) => (url.startsWith("http://") ? redirect("https://example.com/") : page("ok")));
    expect((await guard(up)("http://example.com/")).body).toBe("ok");
  });

  it("treats our own origin as unsupported, first URL or redirect target", async () => {
    const own = "community.thinkersjournal.com";
    const first = recorder(() => page("x"));
    expect(await codeOf(guard(first, { selfHosts: [own] })(`https://${own}/p/1`))).toBe("unsupported");
    expect(first.calls).toHaveLength(0);

    const hop = recorder((url) => (new URL(url).hostname === own ? page("x") : redirect(`https://${own}/api/me`)));
    expect(await codeOf(guard(hop, { selfHosts: [own] })("https://example.com/"))).toBe("unsupported");
    expect(hop.calls).toHaveLength(1);
  });
});

describe("guarded fetch: DNS check", () => {
  // Mutation that must fail this: only look at the first answer / skip the check.
  it("refuses when ANY A/AAAA answer is in a blocked range", async () => {
    const rec = recorder(() => page("x"));
    const resolveHost = async () => [PUBLIC_IP, "10.0.0.1"];
    expect(await codeOf(guard(rec, { resolveHost })("https://example.com/"))).toBe("blocked_target");
    expect(rec.calls).toHaveLength(0);
    const v6 = async () => [PUBLIC_IP, "fd00::1"];
    expect(await codeOf(guard(rec, { resolveHost: v6 })("https://example.com/"))).toBe("blocked_target");
  });

  it("does not resolve IPv4 literals (already range-checked) and resolves names once per hop", async () => {
    let resolved = 0;
    const resolveHost = async () => {
      resolved += 1;
      return [PUBLIC_IP];
    };
    const rec = recorder(() => page("x"));
    await guard(rec, { resolveHost })("http://93.184.216.34/");
    expect(resolved).toBe(0);
    await guard(rec, { resolveHost })("https://example.com/");
    expect(resolved).toBe(1);
  });

  it("a name with no DNS answer is not_found", async () => {
    const rec = recorder(() => page("x"));
    expect(await codeOf(guard(rec, { resolveHost: async () => [] })("https://nx.example.com/"))).toBe("not_found");
  });
});

describe("DNS-over-HTTPS resolver", () => {
  it("queries a fixed public resolver for A and AAAA, ignoring CNAME rows", async () => {
    const rec = recorder((url) => {
      const type = new URL(url).searchParams.get("type");
      const answer =
        type === "A"
          ? [{ type: 5, data: "alias.example.net." }, { type: 1, data: "1.2.3.4" }]
          : [{ type: 28, data: "2606:4700::1" }];
      return new Response(JSON.stringify({ Status: 0, Answer: answer }), { headers: { "content-type": "application/dns-json" } });
    });
    const ips = await createDohResolver(rec.fetchImpl)("example.com");
    expect([...ips].sort()).toEqual(["1.2.3.4", "2606:4700::1"]);
    expect(rec.calls.map((c) => new URL(c.url).searchParams.get("type")).sort()).toEqual(["A", "AAAA"]);
    for (const c of rec.calls) {
      expect(new URL(c.url).origin).toBe("https://cloudflare-dns.com");
      expect(new URL(c.url).searchParams.get("name")).toBe("example.com");
      expect(new Headers(c.init.headers).get("accept")).toBe("application/dns-json");
    }
  });

  it("returns [] for NXDOMAIN and throws upstream on a failed resolver", async () => {
    const nx = recorder(() => new Response(JSON.stringify({ Status: 3 })));
    expect(await createDohResolver(nx.fetchImpl)("nx.example.com")).toEqual([]);
    const bad = recorder(() => new Response("oops", { status: 502 }));
    expect(await codeOf(createDohResolver(bad.fetchImpl)("example.com"))).toBe("upstream");
  });
});

/** A body that yields `chunkBytes` of "a" forever (until cancelled) and records how much was pulled. */
function endlessBody(chunkBytes: number, state: { pulled: number; cancelled: boolean }): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode("a".repeat(chunkBytes));
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
}

describe("guarded fetch: the byte cap", () => {
  const CAP = 512 * 1024;

  // Mutation that must fail this: raise the cap, or drop the stream counter (read it all).
  it("truncate mode stops at exactly 512 KB mid-stream and cancels the source", async () => {
    const state = { pulled: 0, cancelled: false };
    const rec = recorder(() => new Response(endlessBody(40_000, state), { headers: HTML }));
    const got = await guard(rec)("https://example.com/", { overflow: "truncate" });
    expect(got.truncated).toBe(true);
    expect(new TextEncoder().encode(got.body).byteLength).toBe(CAP);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(20); // 14 chunks cross the cap; an unbounded read would never return
  });

  it("default mode throws too_large when the body crosses the cap, and cancels the source", async () => {
    const state = { pulled: 0, cancelled: false };
    const rec = recorder(() => new Response(endlessBody(65_536, state), { headers: HTML }));
    expect(await codeOf(guard(rec)("https://example.com/"))).toBe("too_large");
    expect(state.cancelled).toBe(true);
  });

  // Mutation that must fail this: off-by-one in the comparison (>= vs >).
  it("accepts a body of exactly 512 KB and refuses one byte more", async () => {
    const exact = recorder(() => page("a".repeat(CAP)));
    const got = await guard(exact)("https://example.com/");
    expect(got.body.length).toBe(CAP);
    expect(got.truncated).toBe(false);
    const over = recorder(() => page("a".repeat(CAP + 1)));
    expect(await codeOf(guard(over)("https://example.com/"))).toBe("too_large");
  });

  it("honours a lower maxBytes option and never a higher one than the contract allows", async () => {
    const small = recorder(() => page("a".repeat(101)));
    expect(await codeOf(guard(small, { maxBytes: 100 })("https://example.com/"))).toBe("too_large");
    const big = recorder(() => page("a".repeat(CAP + 1)));
    expect(await codeOf(guard(big, { maxBytes: CAP * 4 })("https://example.com/"))).toBe("too_large");
  });
});

describe("guarded fetch: timeout", () => {
  // Mutation that must fail this: drop the AbortSignal/timer.
  it("times out when the server never answers", async () => {
    const rec = recorder((_u) => new Promise<Response>(() => undefined));
    const started = Date.now();
    expect(await codeOf(guard(rec, { timeoutMs: 40 })("https://example.com/"))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("times out when the body stalls after the headers", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("<html>"));
      },
    });
    const rec = recorder(() => new Response(stalled, { headers: HTML }));
    expect(await codeOf(guard(rec, { timeoutMs: 40 })("https://example.com/"))).toBe("timeout");
  });

  it("the timeout covers the whole redirect chain, not each hop", async () => {
    const rec = recorder(
      (_u, n) => new Promise<Response>((resolve) => setTimeout(() => resolve(redirect(`/h${n}`)), 30)),
    );
    expect(await codeOf(guard(rec, { timeoutMs: 80 })("https://example.com/"))).toBe("timeout");
  });

  it("is retryable", async () => {
    const rec = recorder(() => new Promise<Response>(() => undefined));
    const err = await guard(rec, { timeoutMs: 20 })("https://example.com/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).retryable).toBe(true);
  });
});

describe("guarded fetch: content type", () => {
  // Mutation that must fail this: accept any content type.
  it.each(["application/json", "text/plain", "application/pdf", "image/png", "application/octet-stream"])(
    "refuses %s as unsupported",
    async (type) => {
      const rec = recorder(() => page("x", { "content-type": type }));
      expect(await codeOf(guard(rec)("https://example.com/"))).toBe("unsupported");
    },
  );

  it("refuses a missing content-type", async () => {
    const rec = recorder(() => new Response("x", { headers: {} }));
    expect(await codeOf(guard(rec)("https://example.com/"))).toBe("unsupported");
  });

  it.each(["text/html", "TEXT/HTML; charset=ISO-8859-1", "application/xhtml+xml", "text/html;charset=utf-8"])("accepts %s", async (type) => {
    const rec = recorder(() => page("<p>x</p>", { "content-type": type }));
    expect((await guard(rec)("https://example.com/")).body).toBe("<p>x</p>");
  });

  it("allowedTypes lets a connector widen it, and a non-2xx returns an empty body for the caller to judge", async () => {
    const json = recorder(() => page("{}", { "content-type": "application/json" }));
    expect((await guard(json)("https://example.com/", { allowedTypes: ["application/json"] })).body).toBe("{}");
    const gone = recorder(() => page("nope", { "content-type": "application/json" }, 404));
    const got = await guard(gone)("https://example.com/");
    expect(got.status).toBe(404);
    expect(got.body).toBe("");
  });
});

describe("robots.txt", () => {
  // Mutation that must fail this: skip the robots check.
  it("an injected refusal is blocked_target and the page is never requested", async () => {
    const rec = recorder(() => page("x"));
    expect(await codeOf(guard(rec, { robotsAllowed: async () => false })("https://example.com/p"))).toBe("blocked_target");
    expect(rec.calls).toHaveLength(0);
  });

  it("by default fetches the origin's robots.txt once and honours it for our UA", async () => {
    const robots = "User-agent: *\nDisallow: /private\n";
    const rec = recorder((url) => (url.endsWith("/robots.txt") ? page(robots, { "content-type": "text/plain" }) : page("ok")));
    const g = createGuardedFetch({ fetchImpl: rec.fetchImpl, resolveHost: async () => [PUBLIC_IP] });
    expect(await codeOf(g("https://example.com/private/x"))).toBe("blocked_target");
    expect((await g("https://example.com/public")).body).toBe("ok");
    expect(rec.calls.filter((c) => c.url.endsWith("/robots.txt")).length).toBe(2); // once per guarded call (the cache is per call), two calls here
    expect(rec.calls.some((c) => c.url === "https://example.com/private/x")).toBe(false);
  });

  it("a missing robots.txt (404) allows; a 5xx is treated as disallow", async () => {
    const missing = recorder((url) => (url.endsWith("/robots.txt") ? page("", HTML, 404) : page("ok")));
    const g = createGuardedFetch({ fetchImpl: missing.fetchImpl, resolveHost: async () => [PUBLIC_IP] });
    expect((await g("https://example.com/p")).body).toBe("ok");
    const broken = recorder((url) => (url.endsWith("/robots.txt") ? page("", HTML, 503) : page("ok")));
    const g2 = createGuardedFetch({ fetchImpl: broken.fetchImpl, resolveHost: async () => [PUBLIC_IP] });
    expect(await codeOf(g2("https://example.com/p"))).toBe("blocked_target");
  });

  describe("isAllowedByRobots", () => {
    // Mutation that must fail these: ignore the UA-specific group, or treat Allow as non-overriding.
    it("our group beats the * group", () => {
      const t = "User-agent: *\nDisallow: /\n\nUser-agent: ThinkersJournalBot\nDisallow: /secret\n";
      expect(isAllowedByRobots(t, "/open")).toBe(true);
      expect(isAllowedByRobots(t, "/secret/a")).toBe(false);
    });
    it("falls back to * and an empty Disallow allows everything", () => {
      expect(isAllowedByRobots("User-agent: *\nDisallow: /x\n", "/x/y")).toBe(false);
      expect(isAllowedByRobots("User-agent: *\nDisallow:\n", "/x/y")).toBe(true);
      expect(isAllowedByRobots("User-agent: otherbot\nDisallow: /\n", "/x")).toBe(true);
      expect(isAllowedByRobots("", "/x")).toBe(true);
    });
    it("the longest matching rule wins, Allow beating Disallow on a tie", () => {
      const t = "User-agent: *\nDisallow: /docs\nAllow: /docs/public\n";
      expect(isAllowedByRobots(t, "/docs/private")).toBe(false);
      expect(isAllowedByRobots(t, "/docs/public/a")).toBe(true);
      expect(isAllowedByRobots("User-agent: *\nDisallow: /a\nAllow: /a\n", "/a")).toBe(true);
    });
    it("supports * and $ and ignores comments and case in field names", () => {
      const t = "# hi\nuser-AGENT: *\ndisallow: /*.pdf$ # no pdfs\n";
      expect(isAllowedByRobots(t, "/a/b.pdf")).toBe(false);
      expect(isAllowedByRobots(t, "/a/b.pdf?x=1")).toBe(true);
      expect(isAllowedByRobots(t, "/a/b.html")).toBe(true);
    });
  });
});
