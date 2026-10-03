/**
 * The post-commit steps of a content decision, shared by `handleAdminDecision`
 * (routes/admin.ts) and an appeal grant that restores content
 * (routes/admin-appeals.ts). Moved verbatim out of handleAdminDecision
 * (#113 plan B); the comments came with the code.
 *
 * ⚠️ Call it only AFTER the transaction that wrote the decision committed.
 * The author's own notice is NOT here: an appeal grant tells the appellant
 * the appeal's outcome instead, so each caller sends its own.
 */
import { purgeTags } from "../cache/purge";
import { applyMediaVisibilityChange } from "../media/visibility-hook";
import type { LegalHoldCategory } from "../media/legal-hold";
import type { DecisionKind, DecisionResult } from "./decide";
import { sendDsaOutcome } from "./notify-reporter";
import { purgeTagsFor } from "./purge-target";

export interface AfterContentDecisionArgs {
  readonly subject: "post" | "comment";
  /** The decision `result` recorded: an appeal grant passes "restore". */
  readonly decision: DecisionKind;
  /** The trimmed statement of reasons. DSA reporters receive it verbatim. */
  readonly reason: string;
  readonly result: DecisionResult;
  /** #61 — only from handleAdminDecision, only for keep_hidden/remove. */
  readonly legalHold?: { readonly category: LegalHoldCategory; readonly imposedBy: string };
}

export async function afterContentDecision(env: Env, ctx: ExecutionContext, args: AfterContentDecisionArgs): Promise<void> {
  const { subject, decision, reason, result, legalHold } = args;

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

  // DSA (spec §8): every CONFIRMED, open notice this ruling resolved (same
  // transaction — see decide.ts) gets its reporter a statement of reasons.
  // Same after-the-commit, waitUntil discipline as the author notice.
  for (const r of result.dsaReporters) {
    ctx.waitUntil(
      sendDsaOutcome(env, r.email, { decision, reason, subject, postTitle: result.postTitle }).then((sent) => {
        if (!sent) console.error("dsa outcome not sent", { noticeId: r.noticeId, actionId: result.actionId });
      }),
    );
  }
}
