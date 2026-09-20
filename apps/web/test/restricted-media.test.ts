import { describe, expect, it } from "vitest";

import { toRestrictedMediaUrls } from "../src/lib/restricted-media";

describe("toRestrictedMediaUrls", () => {
  it("rewrites a CDN image URL to the restricted-media proxy, carrying the sha256 and postId", () => {
    const sha = "0123456789abcdef".repeat(4); // a synthetic, obviously-fake 64-hex-char key
    const html = `<p><img src="https://cdn.thinkersjournal.com/media/post/${sha}.webp" alt=""></p>`;
    const out = toRestrictedMediaUrls(html, "post-id-123");
    expect(out).toBe(`<p><img src="/api/media-restricted?sha256=${sha}&postId=post-id-123" alt=""></p>`);
  });

  it("rewrites every occurrence when the same image appears more than once", () => {
    const sha = "a".repeat(64);
    const html = `<img src="https://cdn.thinkersjournal.com/media/post/${sha}.webp"><img src="https://cdn.thinkersjournal.com/media/post/${sha}.webp">`;
    const out = toRestrictedMediaUrls(html, "p1");
    expect(out.match(/\/api\/media-restricted\?/g)).toHaveLength(2);
    expect(out).not.toContain("cdn.thinkersjournal.com");
  });

  it("percent-encodes the postId", () => {
    const sha = "b".repeat(64);
    const html = `<img src="https://cdn.thinkersjournal.com/media/post/${sha}.webp">`;
    const out = toRestrictedMediaUrls(html, "id with space");
    expect(out).toContain("postId=id%20with%20space");
  });

  it("leaves non-CDN image URLs and plain text untouched", () => {
    const html = '<p>hello</p><img src="https://example.com/foo.webp">';
    expect(toRestrictedMediaUrls(html, "p1")).toBe(html);
  });

  it("does not match a key with the wrong length (not a real sha256)", () => {
    const html = '<img src="https://cdn.thinkersjournal.com/media/post/abc123.webp">';
    expect(toRestrictedMediaUrls(html, "p1")).toBe(html);
  });
});
