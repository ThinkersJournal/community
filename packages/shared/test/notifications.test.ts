import { describe, expect, it } from "vitest";

import { collapseNotifications, MarkReadInput, NOTIFICATION_KINDS, notificationLabel } from "../src";
import type { CollapsedNotification, NotificationItem } from "../src";

function item(over: Partial<NotificationItem>): NotificationItem {
  return {
    id: crypto.randomUUID(), kind: "post_reaction",
    actor: { username: "u", displayName: null },
    postId: "p1", postTitle: "T", postSlug: "t", commentId: null,
    reactionKind: "insightful", createdAt: "2026-07-24T00:00:00Z", read: false,
    ...over,
  };
}

function group(over: Partial<CollapsedNotification>): CollapsedNotification {
  return {
    key: "k", kind: "post_reaction",
    leadActor: { username: "lead", displayName: "Lead Actor" },
    actorCount: 1,
    postId: "p1", postTitle: "Title", postSlug: "t", commentId: null,
    reactionKind: "insightful", createdAt: "2026-07-24T00:00:00Z",
    ids: ["1"], read: false,
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

describe("notificationLabel", () => {
  it("returns leadName (displayName, falling back to username) and leadUsername unmodified", () => {
    const l1 = notificationLabel(group({ leadActor: { username: "ada", displayName: "Ada L." } }));
    expect(l1.leadUsername).toBe("ada");
    expect(l1.leadName).toBe("Ada L.");

    const l2 = notificationLabel(group({ leadActor: { username: "ada", displayName: null } }));
    expect(l2.leadName).toBe("ada");
  });

  it("follow: singleton reads 'followed you', multi-actor adds the collapse count", () => {
    const single = notificationLabel(group({ kind: "follow", actorCount: 1 }));
    expect(single.rest).toBe(" followed you");

    const multi = notificationLabel(group({ kind: "follow", actorCount: 5 }));
    expect(multi.rest).toContain("and 4 others");
    expect(multi.rest).toBe(" and 4 others followed you");
  });

  it("post_comment: never collapses, names the post title", () => {
    const l = notificationLabel(group({ kind: "post_comment", actorCount: 1, postTitle: "My Post" }));
    expect(l.rest).toBe(" commented on your post «My Post»");
  });

  it("comment_reply: never collapses, names the post title", () => {
    const l = notificationLabel(group({ kind: "comment_reply", actorCount: 1, postTitle: "My Post" }));
    expect(l.rest).toBe(" replied to your comment on «My Post»");
  });

  it("post_reaction: singleton shows the capitalized tone, multi-actor adds the collapse count (no tone)", () => {
    const single = notificationLabel(
      group({ kind: "post_reaction", actorCount: 1, reactionKind: "insightful", postTitle: "My Post" }),
    );
    expect(single.rest).toBe(" found your post «My Post» Insightful");
    expect(single.rest).toContain("Insightful");

    const multi = notificationLabel(
      group({ kind: "post_reaction", actorCount: 5, reactionKind: null, postTitle: "My Post" }),
    );
    expect(multi.rest).toContain("and 4 others");
    expect(multi.rest).toBe(" and 4 others reacted to your post «My Post»");
  });

  it("post_reaction singleton with a null/unknown reactionKind omits the tone (never 'undefined')", () => {
    const l = notificationLabel(
      group({ kind: "post_reaction", actorCount: 1, reactionKind: null, postTitle: "My Post" }),
    );
    expect(l.rest).toBe(" found your post «My Post»");
    expect(l.rest).not.toContain("undefined");
  });

  // The regression this fix closes: comment_reaction's unique key is
  // (kind, postId, commentId) — identical for every reactor on the same
  // comment — so it collapses across actors exactly like follow/post_reaction.
  // Before this fix, the page's label helper silently dropped the "and N
  // others" suffix for this one kind, undercounting "5 people reacted to
  // your comment" down to just the lead actor's name.
  it("comment_reaction: singleton has no suffix, multi-actor MUST include the collapse count (the regression this fix closes)", () => {
    const single = notificationLabel(group({ kind: "comment_reaction", actorCount: 1, postTitle: "My Post" }));
    expect(single.rest).toBe(" reacted to your comment on «My Post»");

    const multi = notificationLabel(group({ kind: "comment_reaction", actorCount: 5, postTitle: "My Post" }));
    expect(multi.rest).toContain("and 4 others");
    expect(multi.rest).toBe(" and 4 others reacted to your comment on «My Post»");
  });

  it("uses the singular 'other' (no trailing s) when actorCount is exactly 2", () => {
    const l = notificationLabel(group({ kind: "follow", actorCount: 2 }));
    expect(l.rest).toBe(" and 1 other followed you");
    expect(l.rest).not.toContain("others");
  });

  it("renders «(untitled)» rather than «null» when postTitle is null (hard-deleted post)", () => {
    const l = notificationLabel(group({ kind: "post_comment", actorCount: 1, postTitle: null }));
    expect(l.rest).toBe(" commented on your post «(untitled)»");
    expect(l.rest).not.toContain("null");
  });
});
