import { describe, expect, it } from "vitest";
import { notifyPostLive } from "../src/notifications/post-live";

const fakeCtx = { waitUntil: (p: Promise<unknown>) => { void p; } };

describe("notifyPostLive()", () => {
  it("pushes the kind to the post's channel", () => {
    const pushed: Array<{ id: string; kind: string }> = [];
    const env = { POST_LIVE: { getByName: (id: string) => ({ push: (k: string) => pushed.push({ id, kind: k }) }) } };
    notifyPostLive(env, fakeCtx, "post-9", "comment");
    expect(pushed).toEqual([{ id: "post-9", kind: "comment" }]);
  });
  it("never throws when the push fails", () => {
    const env = { POST_LIVE: { getByName: () => ({ push: () => { throw new Error("do down"); } }) } };
    expect(() => notifyPostLive(env, fakeCtx, "post-9", "reaction")).not.toThrow();
  });
});
