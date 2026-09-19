/**
 * Reacts to a post/comment's visibility (or legal-hold status) changing by
 * moving its referenced media between the public and restricted buckets
 * (issue #61). Called from `moderation/decide.ts` (and, later, auto-hide and
 * the author-hide PR) AFTER the DB transaction that changed `hidden_at` has
 * committed — a move is a best-effort side effect of a fact already true in
 * Postgres, never a precondition for it.
 *
 * ⚠️ A LEGAL HOLD IS NEVER LIFTED BY `hidden=false`. If a legally-held post is
 * ever restored, its media STAYS restricted — the hold is on the object
 * (`legal-hold.ts`), not the post, and this function deliberately does not
 * attempt to move a held key back to public. That is intentional: a mistaken
 * "restore" on CSAM-flagged content must not re-expose the bytes.
 */
import { withClient } from "../db/client";
import { imposeLegalHold, isKeyLegallyHeld, type LegalHoldCategory } from "./legal-hold";
import { enqueueAndAttemptMove } from "./moves";
import { isKeyPubliclyReachable, mediaKeysReferencedBy } from "./reachability";
import { r2KeyForSha256 } from "./key-pattern";

export interface VisibilityChangeInput {
  readonly subject: "post" | "comment";
  readonly subjectId: string;
  /** The subject's `hidden_at IS NOT NULL` state AFTER the write. */
  readonly hidden: boolean;
  readonly legalHold?: { readonly category: LegalHoldCategory; readonly moderationActionId: string; readonly imposedBy: string };
}

export async function applyMediaVisibilityChange(
  env: Env,
  ctx: ExecutionContext,
  input: VisibilityChangeInput,
): Promise<void> {
  const keys = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    mediaKeysReferencedBy(c, input.subject, input.subjectId),
  );
  if (keys.length === 0) return;

  for (const sha256 of keys) {
    const r2Key = r2KeyForSha256(sha256);

    if (input.legalHold) {
      await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
        imposeLegalHold(c, {
          r2Key,
          imposedBy: input.legalHold!.imposedBy,
          category: input.legalHold!.category,
          moderationActionId: input.legalHold!.moderationActionId,
        }),
      );
      // Unconditional — a legal hold ignores reachability entirely.
      await enqueueAndAttemptMove(env, ctx, r2Key, "to_restricted");
      continue;
    }

    const alreadyHeld = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => isKeyLegallyHeld(c, r2Key));
    if (alreadyHeld) continue; // a prior legal hold on this object always wins

    if (input.hidden) {
      const reachable = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
        isKeyPubliclyReachable(c, sha256, { kind: input.subject, id: input.subjectId }),
      );
      if (!reachable) await enqueueAndAttemptMove(env, ctx, r2Key, "to_restricted");
    } else {
      await enqueueAndAttemptMove(env, ctx, r2Key, "to_public");
    }
  }
}
