// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, it } from "vitest";

import {
  capSnapshot,
  ConnectorError,
  contentHash,
  SNAPSHOT_CAPS,
  type RepoSnapshot,
  type Snapshot,
  type WebSnapshot,
} from "../src/references";

const bytes = (s: Snapshot) => new TextEncoder().encode(JSON.stringify(s)).byteLength;

const web = (over: Partial<WebSnapshot> = {}): WebSnapshot => ({
  kind: "web",
  title: "A title",
  finalUrl: "https://example.com/",
  ...over,
});
const repo = (over: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  kind: "github",
  type: "file",
  title: "t",
  state: "open",
  capturedAt: "2026-11-09T00:00:00Z",
  ...over,
});

describe("ConnectorError", () => {
  it("carries the code, and timeout/upstream are retryable by default", () => {
    const e = new ConnectorError("timeout");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("timeout");
    expect(e.retryable).toBe(true);
    expect(new ConnectorError("blocked_target").retryable).toBe(false);
    expect(new ConnectorError("not_found", "x", true).retryable).toBe(true);
  });
});

describe("capSnapshot", () => {
  it("leaves a small snapshot untouched and does not mutate its input", () => {
    const s = web({ description: "d", siteName: "s", image: { storage: "remote", url: "https://e.com/a.png" } });
    const copy = structuredClone(s);
    expect(capSnapshot(s)).toEqual(copy);
    expect(s).toEqual(copy);
  });

  // Mutation that must fail this: remove a field cap.
  it("caps title 300, description 600, site name", () => {
    const got = capSnapshot(web({ title: "t".repeat(5000), description: "d".repeat(5000), siteName: "s".repeat(5000) }));
    if (got.kind !== "web") throw new Error("kind changed");
    expect(got.title.length).toBe(SNAPSHOT_CAPS.title);
    expect(got.description?.length).toBe(SNAPSHOT_CAPS.description);
    expect(got.siteName?.length).toBe(SNAPSHOT_CAPS.siteName);
  });

  it("caps an excerpt at 40 lines, then at 4096 characters", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const a = capSnapshot(repo({ excerpt: lines }));
    if (a.kind === "web") throw new Error("kind changed");
    expect(a.excerpt?.split("\n")).toHaveLength(SNAPSHOT_CAPS.excerptLines);
    expect(a.excerpt?.startsWith("line 0\nline 1\n")).toBe(true);

    const b = capSnapshot(repo({ excerpt: "x".repeat(50_000) }));
    if (b.kind === "web") throw new Error("kind changed");
    expect(b.excerpt?.length).toBe(SNAPSHOT_CAPS.excerptUtf16Units);
  });

  // Mutation that must fail this: drop the total-size pass.
  it("keeps total JSON at or under 16 KB even for 4-byte characters and escapes, trimming the excerpt first", () => {
    const wide = "\u{1F600}".repeat(2000); // 4000 UTF-16 units, 8000 bytes
    const ctrl = "\u0001".repeat(4000); // 6 bytes each once JSON-escaped
    const s = repo({ title: wide.slice(0, 300), excerpt: ctrl, path: wide.slice(0, 500), state: wide.slice(0, 100) });
    const got = capSnapshot(s);
    expect(bytes(got)).toBeLessThanOrEqual(SNAPSHOT_CAPS.totalJsonBytes);
    if (got.kind === "web") throw new Error("kind changed");
    expect(got.title.length).toBeGreaterThan(0);
    expect((got.excerpt ?? "").length).toBeLessThan(4000);
  });

  it("never splits a surrogate pair when truncating", () => {
    const got = capSnapshot(web({ title: "\u{1F600}".repeat(400) }));
    if (got.kind !== "web") throw new Error("kind changed");
    expect(got.title.length).toBeLessThanOrEqual(SNAPSHOT_CAPS.title);
    const last = got.title.charCodeAt(got.title.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("never throws or rejects, whatever the content (empty strings, oversized image URL)", () => {
    expect(() => capSnapshot(web({ title: "" }))).not.toThrow();
    const got = capSnapshot(web({ image: { storage: "remote", url: `https://e.com/${"a".repeat(10_000)}` } }));
    expect(bytes(got)).toBeLessThanOrEqual(SNAPSHOT_CAPS.totalJsonBytes);
    if (got.kind !== "web") throw new Error("kind changed");
    expect(got.image).toBeUndefined();
  });
});

describe("contentHash", () => {
  const sha256hex = async (s: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // Mutation that must fail this: hash JSON.stringify without sorting keys.
  it("is SHA-256 hex over key-sorted canonical JSON, independent of key order", async () => {
    const a: Snapshot = { kind: "web", title: "t", finalUrl: "https://e.com" };
    const b = { finalUrl: "https://e.com", title: "t", kind: "web" } as Snapshot;
    expect(await contentHash(a)).toBe(await sha256hex('{"finalUrl":"https://e.com","kind":"web","title":"t"}'));
    expect(await contentHash(b)).toBe(await contentHash(a));
    expect(await contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sorts nested keys and ignores undefined fields", async () => {
    const a = web({ image: { storage: "remote", url: "https://e.com/a.png", alt: "x" } });
    const b = web({ image: { alt: "x", url: "https://e.com/a.png", storage: "remote" }, description: undefined });
    expect(await contentHash(a)).toBe(await contentHash(b));
  });

  // Mutation that must fail this: include capturedAt in the hash.
  it("ignores timestamps but changes with any rendered field", async () => {
    const base = repo();
    const h = await contentHash(base);
    expect(await contentHash(repo({ capturedAt: "2030-01-01T00:00:00Z" }))).toBe(h);
    expect(await contentHash(repo({ title: "other" }))).not.toBe(h);
    expect(await contentHash(repo({ state: "closed" }))).not.toBe(h);
    expect(await contentHash(repo({ lines: [1, 2] }))).not.toBe(h);
  });
});
