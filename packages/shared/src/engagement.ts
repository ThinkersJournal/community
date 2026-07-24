/**
 * ENGAGEMENT WIRE TYPES (M2.2) — comments + reactions, shared by both Workers.
 * Same viewer-scoping discipline as posts.ts: `CommentRow`/`CommentsPage`/
 * `PublicReactions` are ANONYMOUS shapes (safe in cached HTML / public reads);
 * `MyReactions` is viewer-scoped and must never reach a shared cache.
 *
 * ⚠️ PURE ON PURPOSE — NO ZOD HERE. `REACTION_KINDS`/`REACTION_LABELS` are
 * imported by notifications.ts, which the nav bell island (ships to every
 * page) pulls in for its display helpers. The `CreateCommentInput` /
 * `UpdateCommentInput` / `ReactionInput` zod schemas live in the sibling
 * ./engagement-write module instead — co-locating them here would drag zod
 * into that global bundle even though the bell never uses them. Do not
 * reintroduce a zod import here.
 */

/** 10k chars — a comment is a comment, not a post (posts cap at ~100k). */
export const COMMENT_MAX = 10_000;

/** The four thinker tones — order is display order. DB CHECK mirrors this list. */
export const REACTION_KINDS = ["insightful", "curious", "agree", "challenging"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

/** Display wording (founder-final, standing decision #12). */
export const REACTION_LABELS: Record<ReactionKind, string> = {
  insightful: "Insightful",
  curious: "Curious",
  agree: "Agree",
  challenging: "Challenging",
};

export type ReactionCounts = Record<ReactionKind, number>;

/** `GET /public/reactions?postId=` — per-kind counts for the post AND all its comments. */
export interface PublicReactions {
  post: ReactionCounts;
  comments: Record<string, ReactionCounts>;
}

/** `GET /reactions/mine?postId=` — the signed-in viewer's own toggles. Never cached. */
export interface MyReactions {
  post: ReactionKind[];
  comments: Record<string, ReactionKind[]>;
}

export interface CommentAuthor {
  /** Public (same class as PublicPost.authorId) — safe in cached HTML data-attrs. */
  userId: string;
  username: string;
  displayName: string | null;
}

/** One comment in path order. Tombstones: `deleted: true`, empty body, null author. */
export interface CommentRow {
  id: string;
  parentId: string | null;
  depth: number;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  bodyMarkdown: string;
  author: CommentAuthor | null;
}

/** `GET /public/comments?postId=&cursor=` — keyset page over `path` ASC. */
export interface CommentsPage {
  comments: CommentRow[];
  /** The last row's `path` on this page, or null when there are no more. */
  nextCursor: string | null;
}
