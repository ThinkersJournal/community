// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.1b: the `web` connector (spec 3, 5, 9). Each test names the mutation that must turn it red.
import { ConnectorError, SNAPSHOT_CAPS, type FetchCtx, type FetchedPage, type FetchInit, type StoredReference } from "@thinkersjournal/shared";
import { describe, expect, it } from "vitest";

import { webConnector } from "../src/references/connectors/web";
import { OriginRateLimitedError } from "../src/references/origin-limit";

const URL_A = "https://example.com/post/1";
const HTML = (head: string) => `<!doctype html><html><head>${head}</head><body>x</body></html>`;
const OG = HTML(
  `<title>Plain</title><meta property="og:title" content="The title"><meta property="og:description" content="The description">` +
    `<meta property="og:site_name" content="Example"><meta property="og:image" content="https://img.example.com/a.png">`,
);

function page(over: Partial<FetchedPage> = {}): FetchedPage {
  return { status: 200, finalUrl: URL_A, contentType: "text/html", headers: {}, body: OG, truncated: false, ...over };
}
interface Seen {
  url: string;
  init: FetchInit | undefined;
}
function ctxOf(handler: (url: string) => FetchedPage | Error): { ctx: FetchCtx; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    ctx: {
      fetch: async (url, init) => {
        seen.push({ url: String(url), init });
        const out = handler(String(url));
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
}
const stored = (over: Partial<StoredReference> = {}): StoredReference => ({
  kind: "web",
  resourceKey: `web:${URL_A}`,
  canonicalUrl: URL_A,
  snapshot: null,
  contentHash: "h".repeat(64),
  ...over,
});
function identified(url: string) {
  const id = webConnector.identify(new URL(url));
  if (id === null) throw new Error(`identify refused ${url}`);
  return id;
}

describe("web connector: identify (pure)", () => {
  it("claims http(s) and keys it as web:<normalised url> with the fragment removed", () => {
    expect(webConnector.identify(new URL("https://Example.com/a?x=1#frag"))).toEqual({
      kind: "web",
      canonicalUrl: "https://example.com/a?x=1",
      resourceKey: "web:https://example.com/a?x=1",
    });
  });

  it.each(["ftp://example.com/a", "mailto:a@example.com", "javascript:alert(1)", "data:text/html,x"])("does not claim %s", (u) => {
    expect(webConnector.identify(new URL(u))).toBeNull();
  });

  // Mutation that must fail: drop the self-origin check (spec 5 rule 8).
  it("does not claim our own origin", () => {
    expect(webConnector.identify(new URL("https://community.thinkersjournal.com/@a/b"))).toBeNull();
  });
});

describe("web connector: resolve", () => {
  it("builds a capped web snapshot, a content hash, and the validators from the response", async () => {
    const { ctx } = ctxOf(() => page({ headers: { etag: '"abc"', "last-modified": "Mon, 09 Nov 2026 10:00:00 GMT" } }));
    const out = await webConnector.resolve(identified(URL_A), ctx);
    expect(out.snapshot).toEqual({
      kind: "web",
      title: "The title",
      description: "The description",
      siteName: "Example",
      image: { storage: "remote", url: "https://img.example.com/a.png" },
      finalUrl: URL_A,
    });
    expect(out.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.etag).toBe('"abc"');
    expect(out.lastModified).toBe("Mon, 09 Nov 2026 10:00:00 GMT");
    expect(out.resourceKey).toBe(`web:${URL_A}`);
  });

  it("fetches only through ctx.fetch", async () => {
    const { ctx, seen } = ctxOf(() => page());
    await webConnector.resolve(identified(URL_A), ctx);
    expect(seen.map((s) => s.url)).toEqual([URL_A]);
  });

  // Mutation that must fail: skip capSnapshot (store the raw title).
  it("caps the snapshot (spec 3.1)", async () => {
    const long = "t".repeat(SNAPSHOT_CAPS.title * 3);
    const { ctx } = ctxOf(() => page({ body: HTML(`<title>${long}</title>`) }));
    const out = await webConnector.resolve(identified(URL_A), ctx);
    expect(out.snapshot.kind === "web" && out.snapshot.title.length).toBeLessThanOrEqual(SNAPSHOT_CAPS.title);
  });

  it("the same content hashes the same, different content differently", async () => {
    const a = await webConnector.resolve(identified(URL_A), ctxOf(() => page()).ctx);
    const b = await webConnector.resolve(identified(URL_A), ctxOf(() => page()).ctx);
    const c = await webConnector.resolve(identified(URL_A), ctxOf(() => page({ body: HTML("<title>Other</title>") })).ctx);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
  });

  it("uses the host as the title when the page has none (a card always has a title)", async () => {
    const { ctx } = ctxOf(() => page({ body: HTML("") }));
    const out = await webConnector.resolve(identified(URL_A), ctx);
    expect(out.snapshot.kind === "web" && out.snapshot.title).toBe("example.com");
  });

  it("a same-origin canonical link becomes the resource key", async () => {
    const { ctx } = ctxOf(() => page({ body: HTML('<title>t</title><link rel="canonical" href="https://example.com/post/1-canonical">') }));
    const out = await webConnector.resolve(identified(URL_A), ctx);
    expect(out.resourceKey).toBe("web:https://example.com/post/1-canonical");
  });

  // Mutation that must fail: trust any canonical (this is how one page claims another site's resource key and
  // poisons the dedupe reuse of that key).
  it("a canonical on ANOTHER origin is ignored", async () => {
    const { ctx } = ctxOf(() => page({ body: HTML('<title>t</title><link rel="canonical" href="https://victim.example.org/page">') }));
    const out = await webConnector.resolve(identified(URL_A), ctx);
    expect(out.resourceKey).toBe(`web:${URL_A}`);
  });

  it("a canonical pointing at our own origin is ignored (spec 5 rule 8)", async () => {
    const { ctx } = ctxOf(() => page({ body: HTML('<title>t</title><link rel="canonical" href="https://community.thinkersjournal.com/x">') }));
    const out = await webConnector.resolve(identified(URL_A), ctx);
    expect(out.resourceKey).toBe(`web:${URL_A}`);
  });

  it("the key follows the final URL after redirects", async () => {
    const { ctx } = ctxOf(() => page({ finalUrl: "https://www.example.com/landing" }));
    const out = await webConnector.resolve(identified(URL_A), ctx);
    expect(out.resourceKey).toBe("web:https://www.example.com/landing");
  });

  it.each([[404, "not_found"], [410, "not_found"], [403, "upstream"], [500, "upstream"], [429, "upstream"]])(
    "a %s response is a ConnectorError(%s), never a partial snapshot",
    async (status, code) => {
      const { ctx } = ctxOf(() => page({ status, body: "" }));
      const err = await webConnector.resolve(identified(URL_A), ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).code).toBe(code);
    },
  );

  it("a 5xx and a 429 are retryable; a 404 is not", async () => {
    const run = (status: number) => webConnector.resolve(identified(URL_A), ctxOf(() => page({ status, body: "" })).ctx).catch((e: unknown) => e as ConnectorError);
    expect((await run(503)).retryable).toBe(true);
    expect((await run(429)).retryable).toBe(true);
    expect((await run(404)).retryable).toBe(false);
  });
});

describe("web connector: fetchLive keeps ACCESS apart from DIFF (spec 3)", () => {
  const snapshotOf = async (html = OG) => {
    const out = await webConnector.resolve(identified(URL_A), ctxOf(() => page({ body: html })).ctx);
    return stored({ snapshot: out.snapshot, contentHash: out.contentHash, etag: '"v1"', lastModified: "Mon, 09 Nov 2026 10:00:00 GMT" });
  };

  it("sends a conditional GET with the stored validators", async () => {
    const ref = await snapshotOf();
    const { ctx, seen } = ctxOf(() => page({ status: 304, body: "" }));
    await webConnector.fetchLive(ref, ctx);
    expect(seen[0]?.init?.headers).toEqual({ "if-none-match": '"v1"', "if-modified-since": "Mon, 09 Nov 2026 10:00:00 GMT" });
  });

  it("304 is not_modified / unchanged", async () => {
    const out = await webConnector.fetchLive(await snapshotOf(), ctxOf(() => page({ status: 304, body: "" })).ctx);
    expect(out).toEqual({ access: "not_modified", diff: "unchanged" });
  });

  // Mutation that must fail: map only 404 to gone (or map 5xx to gone).
  it.each([404, 410])("%s is gone / gone (the only definitive answer)", async (status) => {
    const out = await webConnector.fetchLive(await snapshotOf(), ctxOf(() => page({ status, body: "" })).ctx);
    expect(out).toEqual({ access: "gone", diff: "gone" });
  });

  // Mutation that must fail: map 5xx to gone.
  it.each([500, 502, 503, 504])("%s is error / unknown, NEVER gone", async (status) => {
    const out = await webConnector.fetchLive(await snapshotOf(), ctxOf(() => page({ status, body: "" })).ctx);
    expect(out.access).toBe("error");
    expect(out.diff).toBe("unknown");
  });

  // Mutation that must fail: let a rate-limited answer carry a diff (it must leave live_state untouched).
  it("429 is rate_limited / unknown and carries no snapshot to store", async () => {
    const out = await webConnector.fetchLive(await snapshotOf(), ctxOf(() => page({ status: 429, body: "" })).ctx);
    expect(out).toEqual({ access: "rate_limited", diff: "unknown" });
  });

  it("401/403 is forbidden / unknown (turned private: no new content)", async () => {
    for (const status of [401, 403]) {
      const out = await webConnector.fetchLive(await snapshotOf(), ctxOf(() => page({ status, body: "" })).ctx);
      expect(out).toEqual({ access: "forbidden", diff: "unknown" });
    }
  });

  it("a timeout or upstream failure is error / unknown", async () => {
    for (const e of [new ConnectorError("timeout"), new ConnectorError("upstream"), new ConnectorError("not_found", "dns"), new ConnectorError("unsupported")]) {
      const out = await webConnector.fetchLive(await snapshotOf(), ctxOf(() => e).ctx);
      expect(out).toEqual({ access: "error", diff: "unknown" });
    }
  });

  it("our own per-origin limit is rate_limited / unknown", async () => {
    const out = await webConnector.fetchLive(await snapshotOf(), ctxOf(() => new OriginRateLimitedError("upstream", "limited", true)).ctx);
    expect(out).toEqual({ access: "rate_limited", diff: "unknown" });
  });

  it("a robots or SSRF refusal on a refresh is forbidden / unknown", async () => {
    const out = await webConnector.fetchLive(await snapshotOf(), ctxOf(() => new ConnectorError("blocked_target")).ctx);
    expect(out).toEqual({ access: "forbidden", diff: "unknown" });
  });

  it("a 200 with the same content is ok / unchanged and says so by hash", async () => {
    const ref = await snapshotOf();
    const out = await webConnector.fetchLive(ref, ctxOf(() => page({ headers: { etag: '"v2"' } })).ctx);
    expect(out.access).toBe("ok");
    expect(out.diff).toBe("unchanged");
    expect(out.contentHash).toBe(ref.contentHash);
    expect(out.etag).toBe('"v2"');
  });

  it("a 200 with different content is ok / changed with the new snapshot and hash", async () => {
    const ref = await snapshotOf();
    const out = await webConnector.fetchLive(ref, ctxOf(() => page({ body: HTML('<meta property="og:title" content="Edited">') })).ctx);
    expect(out.access).toBe("ok");
    expect(out.diff).toBe("changed");
    expect(out.snapshot?.kind === "web" && out.snapshot.title).toBe("Edited");
    expect(out.contentHash).not.toBe(ref.contentHash);
  });
});

describe("web connector: deepLink", () => {
  it("is the canonical public URL", () => {
    expect(webConnector.deepLink(stored({ canonicalUrl: "https://example.com/c" }))).toBe("https://example.com/c");
  });
});
