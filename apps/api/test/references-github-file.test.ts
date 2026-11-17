// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.3e: the github connector's file card. resolve PINS a commit SHA (so line numbers cannot drift) and takes the lines;
// fetchLive re-reads the branch the author linked and says `changed` when the text at those lines now differs.
import {
  ApiCredential,
  ConnectorError,
  contentHash,
  type FetchCtx,
  type FetchedPage,
  type FetchInit,
  type RepoSnapshot,
  type StoredReference,
} from "@thinkersjournal/shared";
import { describe, expect, it } from "vitest";

import { createGithubConnector } from "../src/references/connectors/github";

import type { InstallationAuth } from "../src/references/github-installation-auth";

const AT = new Date("2026-11-16T12:00:00.000Z");
const TOKEN = "ghs_FAKETOKEN";
const SHA = "a".repeat(40);
const HEAD = "b".repeat(40);
const auth: InstallationAuth = { credential: async () => new ApiCredential("Bearer", TOKEN) };
const connector = createGithubConnector({ auth, now: () => AT });

const RAW = "application/vnd.github.raw+json; charset=utf-8";
function json(status: number, body: unknown, headers: Record<string, string> = {}): FetchedPage {
  return { status, finalUrl: "https://api.github.com/", contentType: "application/json", headers, body: JSON.stringify(body), truncated: false };
}
function raw(text: string, headers: Record<string, string> = {}): FetchedPage {
  return { status: 200, finalUrl: "https://api.github.com/", contentType: RAW, headers, body: text, truncated: false };
}
function status(s: number, headers: Record<string, string> = {}): FetchedPage {
  return { status: s, finalUrl: "https://api.github.com/", contentType: "application/json", headers, body: "", truncated: false };
}

function stub(routes: Record<string, FetchedPage>) {
  const calls: Array<{ url: string; init: FetchInit | undefined }> = [];
  const ctx: FetchCtx = {
    async fetch(url, init) {
      const u = String(url);
      calls.push({ url: u, init });
      const hit = routes[u.replace("https://api.github.com", "")];
      if (hit === undefined) return status(404);
      return hit;
    },
  };
  return { ctx, calls };
}

const idOf = (u: string) => {
  const id = connector.identify(new URL(u));
  if (id === null) throw new Error(`not claimed: ${u}`);
  return id;
};

const FILE = "line1\nline2\nline3\nline4\nline5\n";
const MAIN = idOf("https://github.com/octo/repo/blob/main/src/a.ts#L2-L3");

describe("github file resolve", () => {
  it("pins the commit SHA, then reads the file AT that SHA and keeps lines a..b", async () => {
    const { ctx, calls } = stub({ "/repos/octo/repo/commits/main": json(200, { sha: SHA }), [`/repos/octo/repo/contents/src/a.ts?ref=${SHA}`]: raw(FILE) });
    const got = await connector.resolve(MAIN, ctx);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/octo/repo/commits/main",
      `https://api.github.com/repos/octo/repo/contents/src/a.ts?ref=${SHA}`,
    ]);
    expect(calls[1]?.init?.headers?.accept).toBe("application/vnd.github.raw+json");
    for (const c of calls) expect(c.init?.api?.credential?.reveal()).toBe(`Bearer ${TOKEN}`);
    expect(got.resourceKey).toBe("github:octo/repo#file:main/src/a.ts#L2-L3");
    expect(got.snapshot).toEqual({
      kind: "github",
      type: "file",
      title: "a.ts",
      state: "file",
      path: "src/a.ts",
      ref: SHA,
      lines: [2, 3],
      excerpt: "line2\nline3",
      capturedAt: AT.toISOString(),
    });
    expect(got.contentHash).toBe(await contentHash(got.snapshot));
  });

  it("a ref with a slash is found by trying one segment, then two", async () => {
    const id = idOf("https://github.com/octo/repo/blob/feature/x/src/a.ts#L1-L1");
    const { ctx, calls } = stub({ "/repos/octo/repo/commits/feature/x": json(200, { sha: SHA }), [`/repos/octo/repo/contents/src/a.ts?ref=${SHA}`]: raw(FILE) });
    const got = await connector.resolve(id, ctx);
    expect(calls.slice(0, 2).map((c) => c.url)).toEqual([
      "https://api.github.com/repos/octo/repo/commits/feature",
      "https://api.github.com/repos/octo/repo/commits/feature/x",
    ]);
    expect(got.snapshot).toMatchObject({ path: "src/a.ts", lines: [1, 1], excerpt: "line1" });
  });

  it("gives up after four candidate refs (not_found)", async () => {
    const id = idOf("https://github.com/octo/repo/blob/a/b/c/d/e/f.ts#L1");
    const { ctx, calls } = stub({});
    const err = (await connector.resolve(id, ctx).catch((e: unknown) => e)) as ConnectorError;
    expect(err.code).toBe("not_found");
    expect(calls).toHaveLength(4);
  });

  it("a range past the end of the file clamps to the lines that exist; a start past the end is not_found", async () => {
    const routes = { "/repos/octo/repo/commits/main": json(200, { sha: SHA }), [`/repos/octo/repo/contents/src/a.ts?ref=${SHA}`]: raw(FILE) };
    const clamped = await connector.resolve(idOf("https://github.com/octo/repo/blob/main/src/a.ts#L4-L99"), stub(routes).ctx);
    expect(clamped.snapshot).toMatchObject({ lines: [4, 5], excerpt: "line4\nline5" });
    const err = (await connector.resolve(idOf("https://github.com/octo/repo/blob/main/src/a.ts#L50-L60"), stub(routes).ctx).catch((e: unknown) => e)) as ConnectorError;
    expect(err.code).toBe("not_found");
  });

  it("keeps at most 40 lines of a long range (the card cap) and says which lines they are", async () => {
    const big = Array.from({ length: 200 }, (_, i) => `l${i + 1}`).join("\n");
    const routes = { "/repos/octo/repo/commits/main": json(200, { sha: SHA }), [`/repos/octo/repo/contents/src/a.ts?ref=${SHA}`]: raw(big) };
    const got = await connector.resolve(idOf("https://github.com/octo/repo/blob/main/src/a.ts#L10-L150"), stub(routes).ctx);
    const snap = got.snapshot as RepoSnapshot;
    expect(snap.lines).toEqual([10, 49]);
    expect((snap.excerpt ?? "").split("\n")).toHaveLength(40);
  });

  it("a missing file at the pinned commit is not_found; the commit lookup's text is never carried", async () => {
    const { ctx } = stub({ "/repos/octo/repo/commits/main": json(200, { sha: SHA, message: "ghs_LEAK" }) });
    const err = (await connector.resolve(MAIN, ctx).catch((e: unknown) => e)) as ConnectorError;
    expect(err.code).toBe("not_found");
    expect(err.message).not.toContain("ghs_LEAK");
  });

  it("a binary file (a NUL byte) is unsupported", async () => {
    const { ctx } = stub({ "/repos/octo/repo/commits/main": json(200, { sha: SHA }), [`/repos/octo/repo/contents/src/a.ts?ref=${SHA}`]: raw("ab\u0000cd") });
    const err = (await connector.resolve(MAIN, ctx).catch((e: unknown) => e)) as ConnectorError;
    expect(err.code).toBe("unsupported");
  });

  it("a file over the door's byte cap is too_large (the guard's own error passes through)", async () => {
    let n = 0;
    const ctx: FetchCtx = {
      async fetch() {
        n += 1;
        if (n === 1) return json(200, { sha: SHA });
        throw new ConnectorError("too_large", "response over cap");
      },
    };
    const err = (await connector.resolve(MAIN, ctx).catch((e: unknown) => e)) as ConnectorError;
    expect(err.code).toBe("too_large");
  });

  it("a malformed commit answer (no sha) is an upstream error", async () => {
    const { ctx } = stub({ "/repos/octo/repo/commits/main": json(200, { nope: 1 }) });
    const err = (await connector.resolve(MAIN, ctx).catch((e: unknown) => e)) as ConnectorError;
    expect(err.code).toBe("upstream");
  });

  it("a 5xx on the commit lookup is a retryable upstream error, not a 'try the next ref'", async () => {
    const id = idOf("https://github.com/octo/repo/blob/feature/x/src/a.ts#L1");
    const { ctx, calls } = stub({ "/repos/octo/repo/commits/feature": status(503) });
    const err = (await connector.resolve(id, ctx).catch((e: unknown) => e)) as ConnectorError;
    expect(err.code).toBe("upstream");
    expect(err.retryable).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("github file fetchLive", () => {
  async function stored(excerpt: string, etag?: string): Promise<StoredReference> {
    const snapshot: RepoSnapshot = { kind: "github", type: "file", title: "a.ts", state: "file", path: "src/a.ts", ref: SHA, lines: [2, 3], excerpt, capturedAt: "2026-11-01T00:00:00.000Z" };
    const ref: StoredReference = { kind: "github", resourceKey: MAIN.resourceKey, canonicalUrl: MAIN.canonicalUrl, snapshot, contentHash: await contentHash(snapshot) };
    if (etag !== undefined) ref.etag = etag;
    return ref;
  }
  const HEAD_URL = "/repos/octo/repo/contents/src/a.ts?ref=main";

  it("re-reads the linked branch (not the pin); the same lines are unchanged even though the branch moved", async () => {
    const { ctx, calls } = stub({ [HEAD_URL]: raw(FILE, { etag: '"f2"' }) });
    const got = await connector.fetchLive(await stored("line2\nline3"), ctx);
    expect(calls).toHaveLength(1); // no commit lookup is needed when nothing changed
    expect(calls[0]?.url).toBe(`https://api.github.com${HEAD_URL}`);
    expect(got).toMatchObject({ access: "ok", diff: "unchanged", etag: '"f2"' });
  });

  it("different text at those lines is changed, with a new snapshot pinned to the branch's current commit", async () => {
    const edited = "line1\nLINE TWO\nline3\nline4\n";
    const { ctx, calls } = stub({ [HEAD_URL]: raw(edited), "/repos/octo/repo/commits/main": json(200, { sha: HEAD }) });
    const got = await connector.fetchLive(await stored("line2\nline3"), ctx);
    expect(got).toMatchObject({ access: "ok", diff: "changed" });
    expect(got.snapshot).toMatchObject({ type: "file", ref: HEAD, lines: [2, 3], excerpt: "LINE TWO\nline3", path: "src/a.ts" });
    expect(got.contentHash).toBe(await contentHash(got.snapshot as RepoSnapshot));
    expect(calls).toHaveLength(2);
  });

  it("lines that no longer exist at the head are changed (the excerpt is now empty), not an error", async () => {
    const { ctx } = stub({ [HEAD_URL]: raw("only one line"), "/repos/octo/repo/commits/main": json(200, { sha: HEAD }) });
    const got = await connector.fetchLive(await stored("line2\nline3"), ctx);
    expect(got).toMatchObject({ access: "ok", diff: "changed" });
  });

  it("sends If-None-Match from the stored etag; 304 is not_modified/unchanged", async () => {
    const { ctx, calls } = stub({ [HEAD_URL]: status(304) });
    const got = await connector.fetchLive(await stored("line2\nline3", '"f1"'), ctx);
    expect(got).toEqual({ access: "not_modified", diff: "unchanged" });
    expect(calls[0]?.init?.headers?.["if-none-match"]).toBe('"f1"');
  });

  it.each([
    [404, { access: "gone", diff: "gone" }],
    [403, { access: "forbidden", diff: "unknown" }],
    [429, { access: "rate_limited", diff: "unknown" }],
    [401, { access: "error", diff: "unknown" }],
    [503, { access: "error", diff: "unknown" }],
  ])("the head read answering %i is %j", async (s, expected) => {
    const { ctx } = stub({ [HEAD_URL]: status(s) });
    expect(await connector.fetchLive(await stored("line2\nline3"), ctx)).toEqual(expected);
  });

  it("with no stored snapshot there is nothing to compare: an access error, never a throw", async () => {
    const ref = await stored("x");
    const { ctx, calls } = stub({});
    expect(await connector.fetchLive({ ...ref, snapshot: null }, ctx)).toEqual({ access: "error", diff: "unknown" });
    expect(calls).toHaveLength(0);
  });

  it("a failed commit lookup after a changed read is an access error (the change is not reported half-known)", async () => {
    const { ctx } = stub({ [HEAD_URL]: raw("a\nb\nc\n"), "/repos/octo/repo/commits/main": status(500) });
    expect(await connector.fetchLive(await stored("line2\nline3"), ctx)).toEqual({ access: "error", diff: "unknown" });
  });
});
