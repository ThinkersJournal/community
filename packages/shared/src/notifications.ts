/**
 * NOTIFICATION WIRE TYPES (M2.3a) + the read-time collapsing helper, shared by
 * both Workers. `NotificationItem`/`NotificationsPage` are viewer-scoped (the
 * recipient's own rows) and never edge-cached.
 *
 * ⚠️ PURE ON PURPOSE — NO ZOD HERE. This module is imported by the nav bell
 * island (apps/web/src/scripts/notify-bell.ts), which ships to EVERY page for
 * EVERY visitor. The `MarkReadInput` zod schema lives in the sibling
 * ./notifications-read module instead, so that consumers of the pure
 * `collapseNotifications`/`notificationLabel` helpers never drag zod into
 * their bundle. Do not reintroduce a zod import here.
 */
import { REACTION_KINDS, REACTION_LABELS } from "./engagement";
import type { ReactionKind } from "./engagement";

export const NOTIFICATION_KINDS = [
  "post_comment", "comment_reply", "post_reaction", "comment_reaction", "follow",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationActor {
  username: string;
  displayName: string | null;
}

/** One enriched notification row as served to its recipient. */
export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  actor: NotificationActor;
  postId: string | null;
  postTitle: string | null;
  postSlug: string | null;
  commentId: string | null;
  reactionKind: string | null;
  createdAt: string;
  read: boolean;
}

/** `GET /notifications` — keyset page of the viewer's notifications. */
export interface NotificationsPage {
  notifications: NotificationItem[];
  nextCursor: string | null;
}

/** A collapsed display group. `actorCount` counts DISTINCT actors. */
export interface CollapsedNotification {
  key: string;
  kind: NotificationKind;
  leadActor: NotificationActor;
  actorCount: number;
  postId: string | null;
  postTitle: string | null;
  postSlug: string | null;
  commentId: string | null;
  /** The tone — present ONLY for a singleton group (one row). */
  reactionKind: string | null;
  createdAt: string; // the newest (first) row's timestamp
  ids: string[]; // every underlying row id (for mark-read of the group)
  read: boolean; // false if ANY underlying row is unread
}

/**
 * Group a page's rows by (kind, postId, commentId), preserving first-occurrence
 * order, counting DISTINCT actors. A pure function over the page — no query.
 * Tone survives only for a singleton (see the spec's double-count note).
 */
export function collapseNotifications(items: NotificationItem[]): CollapsedNotification[] {
  const groups = new Map<string, CollapsedNotification & { actors: Set<string> }>();
  const order: string[] = [];
  for (const it of items) {
    const key = `${it.kind}|${it.postId ?? ""}|${it.commentId ?? ""}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        key, kind: it.kind, leadActor: it.actor, actorCount: 0,
        postId: it.postId, postTitle: it.postTitle, postSlug: it.postSlug,
        commentId: it.commentId, reactionKind: it.reactionKind,
        createdAt: it.createdAt, ids: [], read: true, actors: new Set<string>(),
      };
      groups.set(key, g);
      order.push(key);
    }
    g.ids.push(it.id);
    g.actors.add(it.actor.username);
    if (!it.read) g.read = false;
  }
  return order.map((key) => {
    const g = groups.get(key)!;
    const actorCount = g.actors.size;
    return {
      key: g.key, kind: g.kind, leadActor: g.leadActor, actorCount,
      postId: g.postId, postTitle: g.postTitle, postSlug: g.postSlug,
      commentId: g.commentId,
      reactionKind: g.ids.length === 1 ? g.reactionKind : null,
      createdAt: g.createdAt, ids: g.ids, read: g.read,
    };
  });
}

/** The lead actor's name, split from the §7 sentence tail so callers can render the name as a profile link. */
export interface NotificationLabel {
  leadName: string;
  leadUsername: string;
  /** Starts with a space — read naturally right after the linked lead-actor name. */
  rest: string;
}

/**
 * §7's per-kind display copy for a collapsed group, minus the lead actor's
 * name (rendered separately — every caller links it to `/@{leadUsername}`).
 * PURE — no DOM, no fetch. The single source of the notification sentence,
 * shared by the SSR `/notifications` page and the bell dropdown island, so
 * the two surfaces cannot disagree.
 *
 * `comment_reaction` collapses across actors exactly like `follow` and
 * `post_reaction` (its unique key is `(kind, postId, commentId)`, identical
 * for every reactor on the same comment) — the "and N others" suffix MUST
 * apply there too, or a 5-actor group silently renders as if only 1 person
 * reacted.
 */
export function notificationLabel(group: CollapsedNotification): NotificationLabel {
  const leadUsername = group.leadActor.username;
  const leadName = group.leadActor.displayName ?? group.leadActor.username;
  const title = group.postTitle ?? "(untitled)";
  const n = group.actorCount - 1;
  const others = group.actorCount > 1 ? ` and ${n} other${n === 1 ? "" : "s"}` : "";

  let rest: string;
  switch (group.kind) {
    case "follow":
      rest = `${others} followed you`;
      break;
    case "post_comment":
      rest = ` commented on your post «${title}»`;
      break;
    case "comment_reply":
      rest = ` replied to your comment on «${title}»`;
      break;
    case "post_reaction": {
      // Singleton-vs-collapsed keys off ROW COUNT (ids.length), NOT actorCount:
      // one actor reacting with multiple tones is a collapsed group (>1 row,
      // tone already nulled by collapseNotifications) and must read "reacted to
      // your post", never the single-event "found your post … {Tone}". (`others`
      // below stays actorCount-based — it counts distinct OTHER actors.)
      if (group.ids.length === 1) {
        const isKnownTone =
          group.reactionKind !== null &&
          (REACTION_KINDS as readonly string[]).includes(group.reactionKind);
        const toneSuffix = isKnownTone ? ` ${REACTION_LABELS[group.reactionKind as ReactionKind]}` : "";
        rest = ` found your post «${title}»${toneSuffix}`;
      } else {
        rest = `${others} reacted to your post «${title}»`;
      }
      break;
    }
    case "comment_reaction":
      rest = `${others} reacted to your comment on «${title}»`;
      break;
  }

  return { leadName, leadUsername, rest };
}
