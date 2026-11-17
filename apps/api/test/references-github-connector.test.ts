// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.3d: the github connector's resolve and fetchLive for issues, pull requests and CI check runs. A stub FetchCtx stands in
// for the guarded door and a fake auth for the installation token (no key anywhere).
import {
  ApiCredential,
  ConnectorError,
  contentHash,
  type FetchCtx,
  type FetchedPage,
  type FetchInit,
  type StoredReference,
} from "@thinkersjournal/shared";
import { describe, expect, it } from "vitest";

import { createGithubConnector } from "../src/references/connectors/github";
import { GithubAppConfigError } from "../src/references/github-app-auth";

import type { InstallationAuth } from "../src/references/github-installation-auth";

const AT = new Date("2026-11-16T12:00:00.000Z");
const TOKEN = "ghs_FAKETOKEN";
const auth: InstallationAuth = { credential: async () => new ApiCredential("Bearer", TOKEN) };

function page(status: number, body: unknown, headers: Record<string, string> = {}): FetchedPage {
  return {
    status,
    finalUrl: "https://api.github.com/",
    contentType: "application/json",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    truncated: false,
  };
}

function stub(handler: (url: string) => FetchedPage | Promise<FetchedPage>) {
  const calls: Array<{ url: string; init: FetchInit | undefined }> = [];
  const ctx: FetchCtx = {
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      return handler(String(url));
    },
  };
  return { ctx, calls };
}

const connector = createGithubConnector({ auth, now: () => AT });
const idOf = (u: string) => {
  const id = connector.identify(new URL(u));
  if (id === null) throw new Error(`not claimed: ${u}`);
  return id;
};

const ISSUE = idOf("https://github.com/octo/repo/issues/12");
const PR = idOf("https://github.com/octo/repo/pull/7");
const CHECK = idOf("https://github.com/octo/repo/runs/555");

const issueJson = (over: Record<string, unknown> = {}) => ({ title: "Crash on start", state: "open", user: { login: "alice" }, body: "It crashes.\nSecond line.", ...over });
const prJson = (over: Record<string, unknown> = {}) => ({ title: "Fix crash", state: "open", merged: false, user: { login: "bob" }, body: "Fixes it.", ...over });
const checkJson = (over: Record<string, unknown> = {}) => ({ name: "build", status: "completed", conclusion: "success", ...over });

function stored(id: { resourceKey: string; canonicalUrl: string }, snapshot: StoredReference["snapshot"], etag?: string): Promise<StoredReference> {
  return Promise.resolve(contentHash(snapshot ?? { kind: "github", type: "issue", title: "", state: "", capturedAt: "" })).then((h) => {
    const ref: StoredReference = { kind: "github", resourceKey: id.resourceKey, canonicalUrl: id.canonicalUrl, snapshot, contentHash: h };
    if (etag !== undefined) ref.etag = etag;
    return ref;
  });
}

describe("github resolve", () => {
  it("an issue: GETs the repo issue endpoint with the installation credential and snapshots it", async () => {
    const { ctx, calls } = stub(() => page(200, issueJson(), { etag: 'W/"i1"' }));
    const got = await connector.resolve(ISSUE, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/octo/repo/issues/12");
    expect(calls[0]?.init?.api?.credential?.reveal()).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.init?.headers?.accept).toBe("application/vnd.github+json");
    expect(calls[0]?.init?.allowedTypes).toEqual(["application/json"]);
    expect(got.resourceKey).toBe("github:octo/repo#issue:12");
    expect(got.snapshot).toEqual({
      kind: "github",
      type: "issue",
      title: "Crash on start",
      state: "open",
      author: "alice",
      excerpt: "It crashes.\nSecond line.",
      capturedAt: AT.toISOString(),
    });
    expect(got.etag).toBe('W/"i1"');
    expect(got.contentHash).toBe(await contentHash(got.snapshot));
  });

  it("a pull request: state is merged when merged, else open or closed", async () => {
    for (const [json, state] of [
      [prJson(), "open"],
      [prJson({ state: "closed", merged: true }), "merged"],
      [prJson({ state: "closed", merged: false }), "closed"],
    ] as const) {
      const { ctx, calls } = stub(() => page(200, json));
      const got = await connector.resolve(PR, ctx);
      expect(calls[0]?.url).toBe("https://api.github.com/repos/octo/repo/pulls/7");
      expect(got.snapshot).toMatchObject({ type: "pr", state, author: "bob" });
    }
  });

  it("a check run: the name is the title, state is the conclusion once completed, else the status", async () => {
    const done = await connector.resolve(CHECK, stub(() => page(200, checkJson())).ctx);
    expect(done.snapshot).toMatchObject({ type: "check", title: "build", state: "success" });
    const running = stub(() => page(200, checkJson({ status: "in_progress", conclusion: null })));
    const got = await connector.resolve(CHECK, running.ctx);
    expect(got.snapshot).toMatchObject({ type: "check", state: "in_progress" });
    expect(running.calls[0]?.url).toBe("https://api.github.com/repos/octo/repo/check-runs/555");
  });

  it("a null or absent body gives no excerpt; a missing user gives no author", async () => {
    const got = await connector.resolve(ISSUE, stub(() => page(200, { title: "t", state: "open", body: null, user: null })).ctx);
    expect(got.snapshot).toEqual({ kind: "github", type: "issue", title: "t", state: "open", capturedAt: AT.toISOString() });
  });

  it("text is capped and stripped of invisible controls like every snapshot", async () => {
    const got = await connector.resolve(ISSUE, stub(() => page(200, issueJson({ title: "x".repeat(500) + String.fromCharCode(0x202e), body: "l\n".repeat(100) }))).ctx);
    const snap = got.snapshot;
    expect(snap.kind === "github" && snap.title.length).toBe(300);
    expect(snap.kind === "github" && (snap.excerpt ?? "").split("\n").length).toBeLessThanOrEqual(40);
  });

  it.each([
    [404, "not_found", false],
    [410, "not_found", false],
    [403, "upstream", false],
    [401, "upstream", true],
    [429, "upstream", true],
    [500, "upstream", true],
    [502, "upstream", true],
  ])("an upstream %i is a typed %s error (retryable=%s) that carries no GitHub text", async (status, code, retryable) => {
    const { ctx } = stub(() => page(status, { message: "secret ghs_LEAKED" }));
    const err = await connector.resolve(ISSUE, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe(code);
    expect((err as ConnectorError).retryable).toBe(retryable);
    expect((err as Error).message).not.toContain("ghs_LEAKED");
  });

  it("a rate-limited 403 is retryable", async () => {
    const { ctx } = stub(() => page(403, {}, { "x-ratelimit-remaining": "0" }));
    const err = (await connector.resolve(ISSUE, ctx).catch((e: unknown) => e)) as ConnectorError;
    expect(err.code).toBe("upstream");
    expect(err.retryable).toBe(true);
  });

  it("unreadable JSON is an upstream error", async () => {
    const err = (await connector.resolve(ISSUE, stub(() => page(200, "<html>")).ctx).catch((e: unknown) => e)) as ConnectorError;
    expect(err.code).toBe("upstream");
  });

  it("a missing App config is a ConnectorError (never a raw GithubAppConfigError)", async () => {
    const broken = createGithubConnector({ auth: { credential: () => Promise.reject(new GithubAppConfigError("GITHUB_APP_ID")) }, now: () => AT });
    const err = await broken.resolve(ISSUE, stub(() => page(200, {})).ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe("unsupported");
    expect((err as Error).message).not.toContain("5732881");
  });

  it("with no auth at all, resolve says unsupported and makes no request", async () => {
    const bare = createGithubConnector();
    const { ctx, calls } = stub(() => page(200, {}));
    const err = (await bare.resolve(ISSUE, ctx).catch((e: unknown) => e)) as ConnectorError;
    expect(err.code).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });
});

describe("github fetchLive", () => {
  const snap = async (state: string, type: "issue" | "pr" | "check" = "issue") =>
    ({ kind: "github", type, title: "Crash on start", state, author: "alice", excerpt: "It crashes.\nSecond line.", capturedAt: "2026-11-01T00:00:00.000Z" }) as const;

  it("sends If-None-Match from the stored etag, and 304 is not_modified/unchanged", async () => {
    const { ctx, calls } = stub(() => page(304, ""));
    const got = await connector.fetchLive(await stored(ISSUE, await snap("open"), 'W/"i1"'), ctx);
    expect(got).toEqual({ access: "not_modified", diff: "unchanged" });
    expect(calls[0]?.init?.headers?.["if-none-match"]).toBe('W/"i1"');
    expect(calls[0]?.init?.api?.credential?.reveal()).toBe(`Bearer ${TOKEN}`);
  });

  it("no stored etag, no conditional header", async () => {
    const { ctx, calls } = stub(() => page(200, issueJson()));
    await connector.fetchLive(await stored(ISSUE, await snap("open")), ctx);
    expect(calls[0]?.init?.headers?.["if-none-match"]).toBeUndefined();
  });

  it("the same content is unchanged (capturedAt is not content) and carries the new etag", async () => {
    const { ctx } = stub(() => page(200, issueJson(), { etag: 'W/"i2"' }));
    const got = await connector.fetchLive(await stored(ISSUE, await snap("open")), ctx);
    expect(got).toMatchObject({ access: "ok", diff: "unchanged", etag: 'W/"i2"' });
    expect(got.contentHash).toBeDefined();
  });

  it("an edited title is changed, with the new snapshot and hash", async () => {
    const { ctx } = stub(() => page(200, issueJson({ title: "Crash on launch" })));
    const got = await connector.fetchLive(await stored(ISSUE, await snap("open")), ctx);
    expect(got).toMatchObject({ access: "ok", diff: "changed" });
    expect(got.snapshot).toMatchObject({ title: "Crash on launch" });
    expect(got.contentHash).toBe(await contentHash(got.snapshot as never));
  });

  it.each([
    ["issue closed", ISSUE, "issue", "open", issueJson({ state: "closed" })],
    ["pull request merged", PR, "pr", "open", prJson({ state: "closed", merged: true })],
    ["pull request closed", PR, "pr", "open", prJson({ state: "closed" })],
    ["check completed", CHECK, "check", "in_progress", checkJson()],
  ] as const)("%s is resolved (a done state reached)", async (_n, id, type, was, body) => {
    const { ctx } = stub(() => page(200, body));
    const got = await connector.fetchLive(await stored(id, await snap(was, type)), ctx);
    expect(got).toMatchObject({ access: "ok", diff: "resolved" });
  });

  it("a change after the done state is changed, not resolved again", async () => {
    const { ctx } = stub(() => page(200, issueJson({ state: "closed", title: "Crash on launch" })));
    const got = await connector.fetchLive(await stored(ISSUE, await snap("closed")), ctx);
    expect(got).toMatchObject({ access: "ok", diff: "changed" });
  });

  it("a reopened issue is changed (done state left, not reached)", async () => {
    const { ctx } = stub(() => page(200, issueJson({ state: "open" })));
    const got = await connector.fetchLive(await stored(ISSUE, await snap("closed")), ctx);
    expect(got).toMatchObject({ access: "ok", diff: "changed" });
  });

  it("with no stored snapshot a differing answer is changed", async () => {
    const { ctx } = stub(() => page(200, issueJson()));
    const got = await connector.fetchLive(await stored(ISSUE, null), ctx);
    expect(got).toMatchObject({ access: "ok", diff: "changed" });
  });

  // Access and diff are kept apart: only a definitive 404/410 is gone.
  it.each([
    [404, { access: "gone", diff: "gone" }],
    [410, { access: "gone", diff: "gone" }],
    [403, { access: "forbidden", diff: "unknown" }],
    [451, { access: "forbidden", diff: "unknown" }],
    [429, { access: "rate_limited", diff: "unknown" }],
    [401, { access: "error", diff: "unknown" }],
    [500, { access: "error", diff: "unknown" }],
    [503, { access: "error", diff: "unknown" }],
  ])("status %i answers %j and carries no snapshot", async (status, expected) => {
    const { ctx } = stub(() => page(status, { message: "x" }));
    const got = await connector.fetchLive(await stored(ISSUE, await snap("open")), ctx);
    expect(got).toEqual(expected);
  });

  it("a 403 with the rate limit spent is rate_limited, not forbidden", async () => {
    const { ctx } = stub(() => page(403, {}, { "x-ratelimit-remaining": "0" }));
    expect(await connector.fetchLive(await stored(ISSUE, await snap("open")), ctx)).toEqual({ access: "rate_limited", diff: "unknown" });
  });

  it("a thrown guard refusal or timeout is an access answer, never a throw", async () => {
    const refuse = { async fetch(): Promise<FetchedPage> { throw new ConnectorError("blocked_target", "x"); } } satisfies FetchCtx;
    const time = { async fetch(): Promise<FetchedPage> { throw new ConnectorError("timeout", "x"); } } satisfies FetchCtx;
    expect(await connector.fetchLive(await stored(ISSUE, await snap("open")), refuse)).toEqual({ access: "forbidden", diff: "unknown" });
    expect(await connector.fetchLive(await stored(ISSUE, await snap("open")), time)).toEqual({ access: "error", diff: "unknown" });
  });

  it("a missing App config is an access error answer (the engine retries), not a throw", async () => {
    const broken = createGithubConnector({ auth: { credential: () => Promise.reject(new GithubAppConfigError("GITHUB_APP_ID")) }, now: () => AT });
    const got = await broken.fetchLive(await stored(ISSUE, await snap("open")), stub(() => page(200, {})).ctx);
    expect(got).toEqual({ access: "error", diff: "unknown" });
  });

  it("deepLink is the canonical public URL, never an API URL", async () => {
    const ref = await stored(ISSUE, await snap("open"));
    expect(connector.deepLink(ref)).toBe("https://github.com/octo/repo/issues/12");
  });
});
