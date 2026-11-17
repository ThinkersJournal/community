// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.3b: the authenticated-API path of the one door (PM ruling 2026-11-16, option A; five conditions in HANDOFF.md).
// Mutations that must fail each group are named beside it.
import { ApiCredential, ConnectorError } from "@thinkersjournal/shared";
import { describe, expect, it } from "vitest";

import { createGuardedFetch, type FetchLike, type GuardedFetchOptions } from "../src/references/guarded-fetch";

const PUBLIC_IP = "93.184.216.34";
const JSON_TYPE = { "content-type": "application/json; charset=utf-8" };
const TOKEN = "ghs_SECRETTOKEN123";
const cred = () => new ApiCredential("Bearer", TOKEN);
const API = "https://api.github.com/repos/octo/repo/issues/1";

function json(body: string, status = 200, headers: Record<string, string> = JSON_TYPE): Response {
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

/** No `robotsAllowed` override: the real robots path runs, through the same recorder. */
function guard(rec: Recorder, extra: Partial<GuardedFetchOptions> = {}) {
  return createGuardedFetch({ fetchImpl: rec.fetchImpl, resolveHost: async () => [PUBLIC_IP], ...extra });
}

async function errorOf(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConnectorError) return e;
    throw e;
  }
  throw new Error("expected a ConnectorError, none was thrown");
}

const headersOf = (c: Recorder["calls"][number] | undefined): Headers => new Headers(c?.init.headers);
const JSON_INIT = { allowedTypes: ["application/json"] } as const;

describe("api path: the happy path", () => {
  it("sends the credential as Authorization, GET, no robots.txt fetched, returns the JSON text and its headers", async () => {
    const rec = recorder(() => json('{"number":1}', 200, { ...JSON_TYPE, etag: '"e1"' }));
    const got = await guard(rec)(API, { ...JSON_INIT, api: { credential: cred() }, headers: { accept: "application/vnd.github+json" } });
    expect(got.status).toBe(200);
    expect(got.body).toBe('{"number":1}');
    expect(got.headers.etag).toBe('"e1"');
    expect(rec.calls).toHaveLength(1); // a robots.txt fetch would make it 2
    expect(rec.calls[0]?.url).toBe(API);
    expect(rec.calls[0]?.init.method).toBe("GET");
    expect(headersOf(rec.calls[0]).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headersOf(rec.calls[0]).get("accept")).toBe("application/vnd.github+json");
  });

  it("a POST carries its method and body", async () => {
    const rec = recorder(() => json('{"token":"x"}', 201));
    await guard(rec)("https://api.github.com/app/installations/9/access_tokens", {
      ...JSON_INIT,
      api: { method: "POST", body: "{}", credential: cred() },
    });
    expect(rec.calls[0]?.init.method).toBe("POST");
    expect(rec.calls[0]?.init.body).toBe("{}");
    expect(headersOf(rec.calls[0]).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("a caller-supplied Authorization header does not replace the credential's", async () => {
    const rec = recorder(() => json("{}"));
    await guard(rec)(API, { ...JSON_INIT, api: { credential: cred() }, headers: { Authorization: "Bearer evil" } });
    expect(headersOf(rec.calls[0]).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("a same-host redirect (a renamed repository) keeps the credential on the same origin", async () => {
    const rec = recorder((_u, n) => (n === 1 ? redirect("https://api.github.com/repositories/42/issues/1", 301) : json("{}")));
    await guard(rec)(API, { ...JSON_INIT, api: { credential: cred() } });
    expect(rec.calls).toHaveLength(2);
    expect(headersOf(rec.calls[1]).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });
});

// Condition 1: a CONSTANT allow-list (api.github.com only); a typed refusal per case, and nothing is sent.
describe("api path: refusals (condition 1)", () => {
  it.each([
    ["another host", "https://api.example.com/repos/o/r"],
    ["a github look-alike", "https://api.github.com.evil.test/repos/o/r"],
    ["the web host, not the API host", "https://github.com/octo/repo"],
    ["another scheme (http)", "http://api.github.com/repos/o/r"],
    ["userinfo in the URL", "https://user:pw@api.github.com/repos/o/r"],
    ["a non-default port", "https://api.github.com:8443/repos/o/r"],
  ])("%s: blocked_target, and not one request is made", async (_name, url) => {
    const rec = recorder(() => json("{}"));
    const err = await errorOf(guard(rec)(url, { ...JSON_INIT, api: { credential: cred() } }));
    expect(["blocked_target", "invalid_url"]).toContain(err.code);
    expect(err.code).toBe("blocked_target");
    expect(rec.calls).toHaveLength(0);
    expect(err.message).not.toContain(TOKEN);
  });

  it("a redirect to another host is refused and the credential is never sent there", async () => {
    const rec = recorder(() => redirect("https://evil.test/steal"));
    const err = await errorOf(guard(rec)(API, { ...JSON_INIT, api: { credential: cred() } }));
    expect(err.code).toBe("blocked_target");
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls.some((c) => c.url.includes("evil.test"))).toBe(false);
    expect(err.message).not.toContain(TOKEN);
  });

  it("a redirect to http on the same host is refused (downgrade)", async () => {
    const rec = recorder(() => redirect("http://api.github.com/x"));
    const err = await errorOf(guard(rec)(API, { ...JSON_INIT, api: { credential: cred() } }));
    expect(err.code).toBe("blocked_target");
    expect(rec.calls).toHaveLength(1);
  });

  it("a POST is never redirected", async () => {
    const rec = recorder(() => redirect("https://api.github.com/elsewhere", 307));
    const err = await errorOf(guard(rec)("https://api.github.com/app/installations/9/access_tokens", { ...JSON_INIT, api: { method: "POST", body: "{}", credential: cred() } }));
    expect(err.code).toBe("upstream");
    expect(rec.calls).toHaveLength(1);
  });

  it("without the api option, github's API host is just another web host: no credential path is opened", async () => {
    const rec = recorder((url) => (url.endsWith("/robots.txt") ? new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } }) : json("{}")));
    await guard(rec)(API, { ...JSON_INIT, headers: { authorization: "Bearer caller" } });
    // the GET path is unchanged: robots.txt was consulted first
    expect(rec.calls[0]?.url).toBe("https://api.github.com/robots.txt");
  });
});

// Condition 2: the credential is opaque and is never logged, never in an error string, never copied across origins.
describe("api path: the credential stays secret (condition 2)", () => {
  it("is redacted by String, JSON and template literals", () => {
    const c = cred();
    expect(String(c)).toBe("[redacted]");
    expect(JSON.stringify({ c })).toBe('{"c":"[redacted]"}');
    expect(`${c}`).not.toContain(TOKEN);
  });

  // Mutation that must fail this: keep a caller's Authorization on a cross-origin redirect (see crossOriginInit).
  it("on the ordinary GET path an Authorization header the caller passed is not copied to another origin on redirect", async () => {
    const rec = recorder((url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new URL(url).hostname === "a.test" ? redirect("https://b.test/y") : json("{}", 200, { "content-type": "text/html" });
    });
    await guard(rec)("https://a.test/x", { headers: { authorization: "Bearer caller" }, allowedTypes: ["text/html"] });
    const toB = rec.calls.filter((c) => c.url === "https://b.test/y");
    expect(toB).toHaveLength(1);
    expect(headersOf(toB[0]).get("authorization")).toBeNull();
    const toA = rec.calls.filter((c) => c.url === "https://a.test/x");
    expect(headersOf(toA[0]).get("authorization")).toBe("Bearer caller");
  });
});

// Condition 3: SSRF, byte cap and timeout apply exactly as for GET; robots.txt is skipped ONLY here.
describe("api path: the guards that stay (condition 3)", () => {
  it("DNS resolving to a private address is refused", async () => {
    const rec = recorder(() => json("{}"));
    const err = await errorOf(guard(rec, { resolveHost: async () => ["10.0.0.5"] })(API, { ...JSON_INIT, api: { credential: cred() } }));
    expect(err.code).toBe("blocked_target");
    expect(rec.calls).toHaveLength(0);
  });

  it("the byte cap applies (too_large)", async () => {
    const rec = recorder(() => json("x".repeat(2000)));
    const err = await errorOf(guard(rec, { maxBytes: 100 })(API, { ...JSON_INIT, api: { credential: cred() } }));
    expect(err.code).toBe("too_large");
  });

  it("the timeout applies", async () => {
    const rec = recorder(() => new Promise<Response>(() => undefined));
    const err = await errorOf(guard(rec, { timeoutMs: 20 })(API, { ...JSON_INIT, api: { credential: cred() } }));
    expect(err.code).toBe("timeout");
  });

  it("the content-type allow-list applies (HTML from the API host is unsupported)", async () => {
    const rec = recorder(() => json("<html>", 200, { "content-type": "text/html" }));
    const err = await errorOf(guard(rec)(API, { ...JSON_INIT, api: { credential: cred() } }));
    expect(err.code).toBe("unsupported");
  });

  it("robots.txt is skipped on the api path but a normal fetch still applies it", async () => {
    const deny = (url: string): Response =>
      url.endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } }) : json("{}");
    const apiRec = recorder(deny);
    const ok = await guard(apiRec)(API, { ...JSON_INIT, api: { credential: cred() } });
    expect(ok.status).toBe(200);
    const webRec = recorder(deny);
    const err = await errorOf(guard(webRec)(API, JSON_INIT));
    expect(err.code).toBe("blocked_target");
  });
});
