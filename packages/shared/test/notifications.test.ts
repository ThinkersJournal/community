import { describe, expect, it } from "vitest";

import { collapseNotifications, MarkReadInput, NOTIFICATION_KINDS } from "../src";
import type { NotificationItem } from "../src";

function item(over: Partial<NotificationItem>): NotificationItem {
  return {
    id: crypto.randomUUID(), kind: "post_reaction",
    actor: { username: "u", displayName: null },
    postId: "p1", postTitle: "T", postSlug: "t", commentId: null,
    reactionKind: "insightful", createdAt: "2026-07-24T00:00:00Z", read: false,
    ...over,
  };
}

describe("NOTIFICATION_KINDS", () => {
  it("is the exact five-kind set", () => {
    expect(NOTIFICATION_KINDS).toEqual([
      "post_comment", "comment_reply", "post_reaction", "comment_reaction", "follow",
    ]);
  });
});

describe("MarkReadInput", () => {
  it("accepts {all:true} or a non-empty ids array, rejects both/neither", () => {
    expect(MarkReadInput.safeParse({ all: true }).success).toBe(true);
    expect(MarkReadInput.safeParse({ ids: [crypto.randomUUID()] }).success).toBe(true);
    expect(MarkReadInput.safeParse({}).success).toBe(false);
    expect(MarkReadInput.safeParse({ all: true, ids: [crypto.randomUUID()] }).success).toBe(false);
    expect(MarkReadInput.safeParse({ ids: [] }).success).toBe(false);
    expect(MarkReadInput.safeParse({ ids: ["nope"] }).success).toBe(false);
  });
});

describe("collapseNotifications", () => {
  it("groups same (kind, target) across actors and counts DISTINCT actors", () => {
    const rows = [
      item({ actor: { username: "a", displayName: null } }),
      item({ actor: { username: "b", displayName: null } }),
      item({ actor: { username: "c", displayName: null } }),
    ];
    const [g] = collapseNotifications(rows);
    expect(g!.actorCount).toBe(3);
    expect(g!.leadActor.username).toBe("a"); // first occurrence leads
    expect(g!.reactionKind).toBeNull(); // tone dropped once collapsed
  });

  it("keeps the tone only for a singleton, and counts one actor's multiple tones as ONE", () => {
    const single = collapseNotifications([item({ reactionKind: "agree" })]);
    expect(single[0]!.actorCount).toBe(1);
    expect(single[0]!.reactionKind).toBe("agree");
    // one actor, two tones on the same post → one display group, actorCount 1
    const multi = collapseNotifications([
      item({ actor: { username: "a", displayName: null }, reactionKind: "insightful" }),
      item({ actor: { username: "a", displayName: null }, reactionKind: "agree" }),
    ]);
    expect(multi).toHaveLength(1);
    expect(multi[0]!.actorCount).toBe(1);
    expect(multi[0]!.reactionKind).toBeNull(); // >1 row → tone dropped
  });

  it("does NOT merge different targets or different kinds", () => {
    const rows = [
      item({ postId: "p1" }), item({ postId: "p2" }),
      item({ kind: "post_comment", reactionKind: null }),
    ];
    expect(collapseNotifications(rows)).toHaveLength(3);
  });

  it("carries read=false if ANY row in the group is unread", () => {
    const g = collapseNotifications([
      item({ read: true, actor: { username: "a", displayName: null } }),
      item({ read: false, actor: { username: "b", displayName: null } }),
    ]);
    expect(g[0]!.read).toBe(false);
  });
});
