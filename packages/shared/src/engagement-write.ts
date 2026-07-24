/**
 * The zod input schemas for comment/reaction WRITES, split out of
 * engagement.ts so consumers of the PURE display constants (REACTION_KINDS,
 * REACTION_LABELS, COMMENT_MAX) never pull zod into their bundle — same
 * reasoning as notifications-read.ts. See engagement.ts for the wire types.
 */
import { z } from "zod";

import { COMMENT_MAX } from "./engagement";

export const CreateCommentInput = z.object({
  postId: z.string().uuid(),
  /** Omitted = top-level. The api derives path/depth — the client never sends them. */
  parentId: z.string().uuid().optional(),
  markdownSource: z.string().min(1).max(COMMENT_MAX),
});

export const UpdateCommentInput = z.object({
  markdownSource: z.string().min(1).max(COMMENT_MAX),
});

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
