// SPDX-License-Identifier: MIT OR Apache-2.0
// Adversarial-review regression tests for #286 (items numbered as in the review).
import { ConnectorError } from "@thinkersjournal/shared";
import { describe, expect, it } from "vitest";

import { createGuardedFetch, isAllowedByRobots, type FetchLike } from "../src/references/guarded-fetch";
import { parseOpenGraph } from "../src/references/og-parse";
import { isBlockedIpAddress } from "../src/references/ssrf";

const PUBLIC_IP = "93.184.216.34";
const HTML = { "content-type": "text/html; charset=utf-8" };
const TEXT = { "content-type": "text/plain" };

function page(body: string, headers: Record<string, string> = HTML, status = 200): Response {
  return new Response(body, { status, headers });
}
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}
interface Recorder {
  calls: Array<{ url: string; init: RequestInit }>;
  fetchImpl: FetchLike;
}
function recorder(handler: (url: string, n: number) => Response): Recorder {
  const calls: Recorder["calls"] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, calls.length);
    },
  };
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
const robotsCalls = (rec: Recorder) => rec.calls.filter((c) => c.url.endsWith("/robots.txt"));

describe("review 1: robots applies to every hop", () => {
  // Mutation that must fail this: cache the verdict of the first path per origin (the old behaviour).
  it("/ok redirecting to /private/secret is refused, and robots.txt is fetched exactly once", async () => {
    const robots = "User-agent: *\nDisallow: /private\n";
    const rec = recorder((url) =>
      url.endsWith("/robots.txt") ? page(robots, TEXT) : url.endsWith("/ok") ? redirect("/private/secret") : page("SECRET"),
    );
    const g = createGuardedFetch({ fetchImpl: rec.fetchImpl, resolveHost: async () => [PUBLIC_IP] });
    expect(await codeOf(g("https://example.com/ok"))).toBe("blocked_target");
    expect(rec.calls.some((c) => c.url.endsWith("/private/secret"))).toBe(false);
    expect(robotsCalls(rec)).toHaveLength(1);
  });
});

describe("review 2: a network error mid-body is a ConnectorError", () => {
  // Mutation that must fail this: remove the try/catch around the body read.
  it.each(["too_large", "truncate"] as const)("stream error in %s mode", async (overflow) => {
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("<html>"));
      },
      pull(c) {
        c.error(new TypeError("network connection lost"));
      },
    });
    const rec = recorder(() => new Response(broken, { headers: HTML }));
    const g = createGuardedFetch({ fetchImpl: rec.fetchImpl, resolveHost: async () => [PUBLIC_IP], robotsAllowed: async () => true });
    const err = await g("https://example.com/", { overflow }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe("upstream");
  });
});

describe("review 3: caller headers do not follow a cross-origin redirect", () => {
  const opts = (rec: Recorder) => ({ fetchImpl: rec.fetchImpl, resolveHost: async () => [PUBLIC_IP], robotsAllowed: async () => true });
  const headersOf = (rec: Recorder, i: number) => new Headers(rec.calls[i]?.init.headers);

  // Mutation that must fail this: resend init.headers on every hop.
  it("drops Authorization (and other custom headers) on another origin, keeps Accept-Language", async () => {
    const rec = recorder((url) => (url === "https://example.com/" ? redirect("https://other.example.org/x") : page("ok")));
    await createGuardedFetch(opts(rec))("https://example.com/", {
      headers: { Authorization: "Bearer secret", "X-Token": "t", "Accept-Language": "en" },
    });
    expect(headersOf(rec, 0).get("authorization")).toBe("Bearer secret");
    expect(headersOf(rec, 1).get("authorization")).toBeNull();
    expect(headersOf(rec, 1).get("x-token")).toBeNull();
    expect(headersOf(rec, 1).get("accept-language")).toBe("en");
    expect(headersOf(rec, 1).get("user-agent")).toContain("ThinkersJournalBot");
  });

  it("keeps them on a same-origin redirect", async () => {
    const rec = recorder((url) => (url === "https://example.com/" ? redirect("/b") : page("ok")));
    await createGuardedFetch(opts(rec))("https://example.com/", { headers: { Authorization: "Bearer secret" } });
    expect(headersOf(rec, 1).get("authorization")).toBe("Bearer secret");
  });

  it("does not restore them when a later hop returns to the first origin", async () => {
    const rec = recorder((url, n) => (n === 1 ? redirect("https://other.example.org/") : n === 2 ? redirect("https://example.com/back") : page("ok")));
    await createGuardedFetch(opts(rec))("https://example.com/", { headers: { Authorization: "Bearer secret" } });
    expect(headersOf(rec, 2).get("authorization")).toBeNull();
  });
});

describe("review 5: robots.txt status handling", () => {
  const run = async (status: number) => {
    const rec = recorder((url) => (url.endsWith("/robots.txt") ? page("", TEXT, status) : page("ok")));
    const g = createGuardedFetch({ fetchImpl: rec.fetchImpl, resolveHost: async () => [PUBLIC_IP] });
    return codeOf(g("https://example.com/p"));
  };
  // Mutation that must fail this: treat every 4xx as "no robots.txt".
  it.each([429, 500, 502, 503])("%i fails closed", async (status) => {
    expect(await run(status)).toBe("blocked_target");
  });
  it.each([401, 403, 404, 410])("%i is allowed", async (status) => {
    expect(await run(status)).toBe("no-throw");
  });
});

describe("review 10: robots matching hardening", () => {
  // Mutation that must fail this: compare raw text without normalising unreserved escapes.
  it("%7E and ~ are the same character, in the rule or in the path, either case", () => {
    expect(isAllowedByRobots("User-agent: *\nDisallow: /~private\n", "/%7Eprivate/x")).toBe(false);
    expect(isAllowedByRobots("User-agent: *\nDisallow: /%7eprivate\n", "/~private/x")).toBe(false);
    expect(isAllowedByRobots("User-agent: *\nDisallow: /%61bc\n", "/abc")).toBe(false);
  });
  it("reserved escapes are NOT folded: %2F is not a slash", () => {
    expect(isAllowedByRobots("User-agent: *\nDisallow: /a%2Fb\n", "/a/b")).toBe(true);
    expect(isAllowedByRobots("User-agent: *\nDisallow: /a%2fb\n", "/a%2Fb")).toBe(false);
  });
  // Mutation that must fail this: remove the rule cap.
  it("more than 5000 rules fails closed; exactly 5000 is honoured", () => {
    const rules = (n: number) => `User-agent: *\n${Array.from({ length: n }, (_, i) => `Allow: /p${i}`).join("\n")}\n`;
    expect(isAllowedByRobots(rules(5001), "/other")).toBe(false);
    expect(isAllowedByRobots(rules(5000), "/other")).toBe(true);
  });
  it("a matched URL over 2048 characters fails closed; 2048 is fine", () => {
    expect(isAllowedByRobots("", `/${"a".repeat(2048)}`)).toBe(false);
    expect(isAllowedByRobots("", `/${"a".repeat(2047)}`)).toBe(true);
  });
});

describe("review 8: IPv6 answers from DNS", () => {
  const BLOCKED = [
    "::ffff:8.8.8.8", "::ffff:0:0", "::ffff:808:808", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001::1", "fec0::1", "feff::1",
    "100::1", "100::ffff", "2001:db8::1", "2001:db8:ffff::1", "64:ff9b::7f00:1", "64:ff9b:1::1", "64:ff9b:1:ffff::1",
    "2002:7f00:1::", "2002:a00:1::1", "::1", "fe80::1", "fc00::1", "ff02::1",
  ];
  const ALLOWED = [
    "2606:4700:4700::1111", "2001:1::1", "2001:4860:4860::8888", "fe7f::1", "100:0:0:1::1", "2001:db9::1", "2001:db7::1",
    "64:ff9b::808:808", "64:ff9b:2::1", "2002:808:808::", "::fffe:808:808",
  ];
  // Mutation that must fail this: drop the matching range from isBlockedV6.
  it.each(BLOCKED)("blocks %s", (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(true);
  });
  it.each(ALLOWED)("allows %s", (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(false);
  });
});

describe("review 6 and 9: og-parse", () => {
  const FINAL = "https://example.com/p";
  // Mutation that must fail this: leave U+202E out of the invisible-character set.
  it("strips bidi controls, including ones that arrive as entities", () => {
    const rlo = String.fromCharCode(0x202e);
    const got = parseOpenGraph(`<meta property="og:title" content="evil&#x202E;gnp.exe ${rlo}x&#8296;y">`, FINAL);
    expect(got.title).toBe("evilgnp.exe xy");
    const all = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c, 0x180e, 0x200e, 0x200f]
      .map((c) => String.fromCharCode(c))
      .join("");
    expect(parseOpenGraph(`<meta property="og:title" content="a${all}b">`, FINAL).title).toBe("ab");
  });

  // Mutation that must fail this: accept a canonical that is http, or one on our own host.
  it("drops a canonical that is not https or is on our own origin", () => {
    const link = (href: string) => `<link rel="canonical" href="${href}">`;
    expect(parseOpenGraph(link("http://example.com/x"), FINAL).canonicalUrl).toBeUndefined();
    expect(parseOpenGraph(link("https://community.thinkersjournal.com/p/1"), FINAL).canonicalUrl).toBeUndefined();
    expect(parseOpenGraph(link("https://example.org/x"), FINAL, ["example.org"]).canonicalUrl).toBeUndefined();
    expect(parseOpenGraph(link("https://example.org/x"), FINAL).canonicalUrl).toBe("https://example.org/x");
  });
});
