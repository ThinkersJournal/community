/**
 * The post-commit steps of a content decision, shared by `handleAdminDecision`
 * (routes/admin.ts) and an appeal grant that restores content
 * (routes/admin-appeals.ts). Moved verbatim out of handleAdminDecision
 * (#113 plan B); the comments came with the code.
 *
 * ⚠️ Call it only AFTER the transaction that wrote the decision committed.
 * No notice is sent from here: the author's, the appellant's and the DSA
 * reporters' notices are all queued in the decision's own transaction
 * (notice-enqueue.ts) and sent by the outbox drain.
 */
import { purgeTags } from "../cache/purge";
import { applyMediaVisibilityChange } from "../media/visibility-hook";
import type { LegalHoldCategory } from "../media/legal-hold";
import type { DecisionResult } from "./decide";
import { purgeTagsFor } from "./purge-target";

export interface AfterContentDecisionArgs {
  readonly subject: "post" | "comment";
  readonly result: DecisionResult;
  /** #61 — only from handleAdminDecision, only for keep_hidden/remove. */
  readonly legalHold?: { readonly category: LegalHoldCategory; readonly imposedBy: string };
}

export async function afterContentDecision(env: Env, ctx: ExecutionContext, args: AfterContentDecisionArgs): Promise<void> {
  const { subject, result, legalHold } = args;

  // ⚠️ PURGE AFTER THE COMMIT. Without this a Remove leaves the content served
  // from the edge cache for up to 25 hours (PUBLIC_MAX_AGE + PUBLIC_SWR).
  // Canonical ids come from RETURNING. Awaited; purgeTags never throws.
  // Callers return their 404/403 before calling this, so those purge nothing.
  await purgeTags(env, purgeTagsFor(result.purge));

  // ⚠️ #61 — MEDIA MOVE, AFTER THE COMMIT AND THE PAGE PURGE, AWAITED (not
  // waitUntil): CireSnave's §5.3 standing rule is that a state-change purge
  // happens immediately, and a restricted-media move is part of that same
  // "stop being fetchable now" contract, not a background nicety. Runs for
  // every non-restore decision that actually changed hidden_at (a dismissal —
  // e.g. `keep_hidden` on content that was already hidden with no new media —
  // still runs; applyMediaVisibilityChange no-ops when there is nothing to
  // move).
  await applyMediaVisibilityChange(env, ctx, {
    subject,
    subjectId: result.subjectId,
    hidden: result.hidden,
    legalHold:
      legalHold === undefined
        ? undefined
        : { category: legalHold.category, moderationActionId: result.actionId, imposedBy: legalHold.imposedBy },
  });
}
