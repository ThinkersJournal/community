/**
 * NOTIFICATION WIRE TYPES (M2.3a) + the read-time collapsing helper, shared by
 * both Workers. `NotificationItem`/`NotificationsPage` are viewer-scoped (the
 * recipient's own rows) and never edge-cached.
 */
import { z } from "zod";

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

/** `POST /notifications/read` — mark a set read, or all. Exactly one branch. */
export const MarkReadInput = z
  .object({
    ids: z.array(z.string().uuid()).min(1).optional(),
    all: z.literal(true).optional(),
  })
  .refine((b) => (b.all === true) !== (b.ids !== undefined), {
    message: "exactly one of ids / all",
  });
export type MarkReadValue = z.infer<typeof MarkReadInput>;

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
