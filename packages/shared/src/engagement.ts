/**
 * ENGAGEMENT WIRE TYPES (M2.2) — comments + reactions, shared by both Workers.
 * Same viewer-scoping discipline as posts.ts: `CommentRow`/`CommentsPage`/
 * `PublicReactions` are ANONYMOUS shapes (safe in cached HTML / public reads);
 * `MyReactions` is viewer-scoped and must never reach a shared cache.
 */
import { z } from "zod";

/** 10k chars — a comment is a comment, not a post (posts cap at ~100k). */
export const COMMENT_MAX = 10_000;

export const CreateCommentInput = z.object({
  postId: z.string().uuid(),
  /** Omitted = top-level. The api derives path/depth — the client never sends them. */
  parentId: z.string().uuid().optional(),
  markdownSource: z.string().min(1).max(COMMENT_MAX),
});

export const UpdateCommentInput = z.object({
  markdownSource: z.string().min(1).max(COMMENT_MAX),
});

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

/**
 * `kind` is a plain string HERE so the route can answer the dedicated
 * INVALID_REACTION_KIND code (a z.enum reject would collapse it into
 * INVALID_INPUT). Exactly-one-target IS enforced here — that one is shape.
 */
export const ReactionInput = z
  .object({
    postId: z.string().uuid().optional(),
    commentId: z.string().uuid().optional(),
    kind: z.string(),
  })
  .refine((t) => (t.postId === undefined) !== (t.commentId === undefined), {
    message: "exactly one of postId/commentId",
  });

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
