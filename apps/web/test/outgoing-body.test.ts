import { describe, expect, it } from "vitest";

import { resolveOutgoingBody } from "../src/lib/outgoing-body";

/**
 * `resolveOutgoingBody` — the `body` (JSON) vs `rawBody` (passthrough) merge
 * `apiFetch` uses to build the request it sends over the Service Binding.
 *
 * T17 adds `rawBody` so the media-upload proxy (src/pages/media-upload.ts) can
 * forward a browser's raw image bytes to `POST /media` (apps/api/src/routes/
 * media.ts takes RAW bytes, not multipart — see that route's header) without
 * this module ever parsing or re-encoding them. The property worth pinning: a
 * raw body is passed through byte-for-byte, is NEVER run through
 * `JSON.stringify`, and wins over a JSON `body` if a caller somehow sets both.
 */
describe("resolveOutgoingBody", () => {
  it("passes a raw BodyInit through UNTOUCHED — never JSON.stringify'd", () => {
    const raw = new Uint8Array([0xff, 0xd8, 0xff]); // a JPEG magic-byte prefix
    expect(resolveOutgoingBody(undefined, raw)).toBe(raw);
  });

  it("passes a ReadableStream through as-is (the streamed-upload shape)", () => {
    const stream = new ReadableStream();
    expect(resolveOutgoingBody(undefined, stream)).toBe(stream);
  });

  it("JSON-serializes `body` when there is no rawBody", () => {
    expect(resolveOutgoingBody({ title: "hi" }, undefined)).toBe('{"title":"hi"}');
  });

  it("returns undefined when neither is set (a bodyless GET)", () => {
    expect(resolveOutgoingBody(undefined, undefined)).toBeUndefined();
  });

  it("⚠️ rawBody WINS if both are somehow set — it is never silently dropped in favour of a re-serialized body", () => {
    const raw = "raw-bytes";
    expect(resolveOutgoingBody({ title: "hi" }, raw)).toBe(raw);
  });
});
