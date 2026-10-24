// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The Access-gated admin surface (M4 2a).
 *
 * `GET /admin/whoami` is deliberately the whole of 2a's HTTP surface: it proves
 * the gate end to end — JWKS fetch, signature check, issuer/audience/expiry —
 * without inventing a feature the queue module has not designed yet.
 */
import { checkOrigin } from "../auth/csrf";
import { verificationLinkOrigin } from "../auth/email-verify";
import { errorResponse } from "../http/errors";
import { applyDecision, type DecisionKind } from "../moderation/decide";
import { afterContentDecision } from "../moderation/after-content-decision";
import { sendDsaOrphanedOutcome } from "../moderation/notify-reporter";
import { closeOrphanedDsaNotice, listOpenDsaNotices, orphanedDsaNoticeCandidate } from "../moderation/dsa-notices";
import { requireAdmin } from "../admin/require-admin";
import { withClient } from "../db/client";
import { listOpenQueue } from "../moderation/queue";
import type { LegalHoldCategory } from "../media/legal-hold";
import type { ViolationCategory } from "../moderation/actions";
import {
  CONTRACTUAL_GROUNDS,
  DECISION_DURATION_HOURS,
  LEGAL_GROUNDS,
  REPORT_REASONS,
  type ContractualGround,
  type LegalGround,
} from "@thinkersjournal/shared";
import {
  requestMediaAccess,
  approveMediaAccess,
  listPendingMediaAccessRequests,
} from "../moderation/media-access-requests";
import { r2KeyForSha256 } from "../media/key-pattern";
import { backfillHiddenMedia } from "../media/backfill-hidden-media";

import type { RouteParams } from "../routing";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGAL_HOLD_CATEGORIES: readonly LegalHoldCategory[] = ["csam", "dmca", "other"];

export async function handleAdminWhoami(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  return new Response(JSON.stringify({ email: admin.email, sub: admin.sub }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The moderation review queue. GET, so it does not touch the mutating pipeline.
 *
 * ⚠️ `listOpenQueue` reads HIDDEN rows by design. The gate below is the whole
 * of what keeps that safe — see the property stated in src/moderation/queue.ts.
 */
export async function handleAdminQueue(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const items = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => listOpenQueue(c));

  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const DECISIONS: readonly DecisionKind[] = ["restore", "keep_hidden", "remove"];

/**
 * POST /admin/decision — the three content outcomes (spec §4.3).
 *
 * ⚠️ Account actions are NOT available here (decision #3); they are module 2c.
 * ⚠️ Only a human RULES (`content_restore`/`keep_hidden`/`remove`) — automation never decides; its hide leaves a `content_auto_hide` audit row (#57), which rules on nothing.
 */
export async function handleAdminDecision(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // ⚠️ ORIGIN FIRST, BEFORE THE ACCESS GATE — and this is a real defense, not
  // ceremony. `src/admin/require-admin.ts`'s header spells out why: Cloudflare
  // injects the Access assertion from the `CF_Authorization` COOKIE, so a
  // cross-site form post from a logged-in moderator's browser WOULD carry a
  // valid one. ACCESS PROVES WHO; IT DOES NOT PROVE THE REQUEST WAS INTENDED.
  // Admin routes do not run `runMutatingPipeline` (that authenticates a member
  // session; admins are Access principals), so this check is inline, exactly as
  // signup and login do it.
  if (!checkOrigin(env, request)) {
    // ⚠️ `FORBIDDEN`, not a bespoke code. `ApiErrorCode` is a CLOSED union
    // (packages/shared/src/errors.ts) and signup/login both answer a rejected
    // origin with exactly this — deliberately the SAME response they give a
    // failed Turnstile, so the two defenses cannot be probed apart.
    return errorResponse("FORBIDDEN", 403);
  }

  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // The body was not JSON at all.
    return errorResponse("INVALID_JSON", 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse("INVALID_INPUT", 400);
  }

  const b = body as Record<string, unknown>;
  const subject = b["subject"];
  const subjectId = b["subjectId"];
  const decision = b["decision"];
  const reason = b["reason"];
  // ⚠️ #61 — a legal hold is a DELIBERATE, EXPLICIT choice at decision time,
  // never inferred from `violationCategory`: not every "sexual"-category
  // report is CSAM and not every "ip_infringement" report is a formal DMCA
  // notice. Only meaningful alongside `keep_hidden`/`remove` — see below.
  const legalHold = b["legalHold"];
  const legalHoldCategory = b["legalHoldCategory"];
  // #57 gap 2 — INTERNAL audit / DSA-transparency metadata, optional. Same
  // validation as the account-action route (REPORT_REASONS, mirrored by the
  // moderation_actions CHECK). Never shown to the author.
  const violationCategory = b["violationCategory"];
  // #57 Q3 — a TEMPORARY keep_hidden / remove: the intended end, as hours from
  // now. ⚠️ RECORDED on the audit row only (`action_expires_at`); NO job
  // un-hides the content when it passes. Account-level results never read a
  // content row's expiry (every reader filters on a user_* action kind).
  const durationHours = b["durationHours"];
  // #57 Q5 - the structured grounds, each optional and independent (a decision
  // can be both illegal and a terms violation; neither is required). PROPOSED
  // lists; see the 0031 migration. Shown to the author once notice rendering
  // reads them. Neither means anything on a restore.
  const legalGround = b["legalGround"];
  const contractualGround = b["contractualGround"];

  if (
    (subject !== "post" && subject !== "comment") ||
    typeof subjectId !== "string" || !UUID_RE.test(subjectId) ||
    typeof decision !== "string" || !DECISIONS.includes(decision as DecisionKind) ||
    // The statement of reasons is DSA-required and is shown to the author:
    // whitespace is not a reason.
    typeof reason !== "string" || reason.trim() === "" ||
    (legalHold !== undefined && typeof legalHold !== "boolean") ||
    (legalHold === true && decision === "restore") ||
    (violationCategory !== undefined && !(REPORT_REASONS as readonly unknown[]).includes(violationCategory)) ||
    // A restore clears a violation; a category on it is meaningless.
    (violationCategory !== undefined && decision === "restore") ||
    // A restore ends a restriction; an expiry on it is meaningless.
    (durationHours !== undefined &&
      (!(DECISION_DURATION_HOURS as readonly unknown[]).includes(durationHours) || decision === "restore")) ||
    (legalGround !== undefined &&
      (!(LEGAL_GROUNDS as readonly unknown[]).includes(legalGround) || decision === "restore")) ||
    (contractualGround !== undefined &&
      (!(CONTRACTUAL_GROUNDS as readonly unknown[]).includes(contractualGround) || decision === "restore")) ||
    (legalHold === true && !LEGAL_HOLD_CATEGORIES.includes(legalHoldCategory as LegalHoldCategory))
  ) {
    // The shape was wrong. ⚠️ `INVALID_BODY` is NOT in this codebase's error
    // vocabulary — `packages/shared/src/errors.ts` defines `ApiErrorCode` as a
    // CLOSED union, and using a code outside it is a compile error, not a
    // runtime surprise. The vocabulary's own split is INVALID_JSON (not JSON at
    // all) vs INVALID_INPUT (JSON, wrong shape).
    return errorResponse("INVALID_INPUT", 400);
  }

  const result = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    applyDecision(c, {
      subject,
      subjectId,
      decision: decision as DecisionKind,
      reason: reason.trim(),
      actorAdmin: admin.email,
      violationCategory: violationCategory as ViolationCategory | undefined,
      actionExpiresAt:
        durationHours === undefined ? undefined : new Date(Date.now() + (durationHours as number) * 3_600_000),
      legalGround: legalGround as LegalGround | undefined,
      contractualGround: contractualGround as ContractualGround | undefined,
      accountHold: legalHold === true ? { category: legalHoldCategory as LegalHoldCategory } : undefined,
      // Notice outbox PR 1: the author's notice is rendered and queued, and the
      // appeal token minted, INSIDE the decision's transaction (a failure rolls
      // the decision back). The cron drain sends it; nothing is sent from here.
      enqueueNotice: { origin: verificationLinkOrigin(request) },
    }),
  );

  if (result === null) return errorResponse("NOT_FOUND", 404);

  await afterContentDecision(env, ctx, {
    subject,
    result,
    legalHold: legalHold === true ? { category: legalHoldCategory as LegalHoldCategory, imposedBy: admin.email } : undefined,
  });

  // ⚠️ #138 / #135 — NO ONE TO TELL. The decision above is applied, recorded
  // and fully consequential (audit row, hold, purge, media, the DSA reporters'
  // outcome emails): Art. 16(5)/17 owes the reporter an outcome whatever
  // became of the content, and refusing here would make a legal hold on an
  // anonymised account's content impossible to record. Only the AUTHOR's
  // notice is skipped (decide.ts queued nothing and minted no appeal token: a
  // mint with no message to carry it is a credential nobody can use). ⚠️ The
  // line carries the action id and the reason and NOTHING else — no address
  // (the sentinel, or a real one), no title, no author id.
  if (result.noticeSkip !== null) {
    // ⚠️ Log only a notice that was ACTUALLY suppressed. A restore of
    // never-hidden content is a dismissal that renders no notice at all
    // (renderModerationNotice returns null), so "skipped" there would be a
    // false report.
    const dismissal = decision === "restore" && !result.wasHidden;
    if (!dismissal) {
      console.warn("moderation notice skipped", { actionId: result.actionId, reason: result.noticeSkip });
    }
  }

  // The author's notice is already durable in moderation_notice_outbox (queued
  // in the decision's transaction); the */2 cron drain sends it. No token mint
  // and no waitUntil send happen here any more.
  return decisionOk(result.actionId);
}

/** The decision route's one success body: `{ actionId }` with a 200. */
function decisionOk(actionId: string): Response {
  return new Response(JSON.stringify({ actionId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SHA256_RE = /^[0-9a-f]{64}$/;
/** `r2KeyForSha256`'s inverse, for display only — never used to authorize anything. */
const R2_KEY_TO_SHA256 = /^media\/post\/([0-9a-f]{64})\.webp$/;

/**
 * `GET /admin/media-access-requests` — every UNAPPROVED request (endpoint/UI
 * audit, 2026-09-24). GET, so it does not touch the mutating pipeline, same
 * shape as `GET /admin/queue` just above.
 */
export async function handleListMediaAccessRequests(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const pending = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => listPendingMediaAccessRequests(c));
  const requests = pending.map((r) => ({
    id: r.id,
    // ⚠️ Display only. `approveMediaAccess`'s self-approval refusal compares
    // `requestedBy`/`approvedBy` directly, never this — extraction failing
    // (a key that somehow isn't the expected shape) degrades to showing the
    // raw key, never to hiding or misattributing the row.
    sha256: R2_KEY_TO_SHA256.exec(r.r2Key)?.[1] ?? r.r2Key,
    requestedBy: r.requestedBy,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
  return new Response(JSON.stringify({ requests }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * `POST /admin/media-access-requests` — the FIRST of the two hands (#61).
 * Any Access-verified admin may request; the request alone grants nothing.
 */
export async function handleRequestMediaAccess(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!checkOrigin(env, request)) return errorResponse("FORBIDDEN", 403);
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const sha256 = b["sha256"];
  const reason = b["reason"];
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256) || typeof reason !== "string" || reason.trim() === "") {
    return errorResponse("INVALID_INPUT", 400);
  }

  const id = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    requestMediaAccess(c, { r2Key: r2KeyForSha256(sha256), requestedBy: admin.email, reason: reason.trim() }),
  );
  return new Response(JSON.stringify({ id }), { status: 201, headers: { "content-type": "application/json" } });
}

/**
 * `POST /admin/media-access-requests/:id/approve` — the SECOND hand. Refuses
 * a self-approval (`approveMediaAccess`'s `requested_by <> $2`), matching
 * CireSnave's ruling that legal-hold media access needs "multiple hands".
 */
export async function handleApproveMediaAccess(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
): Promise<Response> {
  if (!checkOrigin(env, request)) return errorResponse("FORBIDDEN", 403);
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const id = params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) return errorResponse("NOT_FOUND", 404);

  const approved = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => approveMediaAccess(c, id, admin.email));
  if (!approved) return errorResponse("NOT_FOUND", 404);

  return new Response(null, { status: 204 });
}

/**
 * `POST /admin/backfill-hidden-media` — the one-off #61 backfill
 * (src/media/backfill-hidden-media.ts). Idempotent; safe to call more than
 * once (e.g. if the response's counts hit the 500-per-table batch cap and more
 * remain).
 */
export async function handleBackfillHiddenMedia(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!checkOrigin(env, request)) return errorResponse("FORBIDDEN", 403);
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const result = await backfillHiddenMedia(env, ctx);
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * `GET /admin/dsa-notices` — every CONFIRMED, unresolved notice (Part of
 * #113, Task 4). GET, so it does not touch the mutating pipeline, same shape
 * as `GET /admin/media-access-requests` above. `listOpenDsaNotices` reads
 * HIDDEN rows on purpose — see its header in `moderation/dsa-notices.ts`.
 */
export async function handleListDsaNotices(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const notices = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => listOpenDsaNotices(c));
  return new Response(
    JSON.stringify({
      notices: notices.map((n) => ({
        id: n.id,
        kind: n.kind,
        targetId: n.targetId,
        excerpt: n.excerpt,
        contentDeleted: n.contentDeleted,
        reason: n.reason,
        statement: n.statement,
        reporterName: n.reporterName,
        reporterEmail: n.reporterEmail,
        createdAt: n.createdAt.toISOString(),
      })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * `POST /admin/dsa-notices/:id/close` — addendum (PM ruling, 2026-10-01): the
 * only way to resolve a notice whose target was deleted by its author before
 * a decision. `decide.ts` resolves by `post_id`/`comment_id`, both NULL on an
 * orphaned row by construction, so it can never reach one. Same Access trust
 * domain, inline `checkOrigin`, and admin error-envelope conventions as
 * `/admin/decision` and the media-access-requests routes above.
 */
export async function handleCloseOrphanedDsaNotice(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
): Promise<Response> {
  if (!checkOrigin(env, request)) return errorResponse("FORBIDDEN", 403);
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const id = params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) return errorResponse("NOT_FOUND", 404);

  const closed = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => closeOrphanedDsaNotice(c, id, admin.email));
  if (closed === null) {
    // ⚠️ The UPDATE's own WHERE already decided eligibility atomically — this
    // second read exists ONLY to pick 404 (no such CONFIRMED notice — that
    // covers both "doesn't exist" and "exists but unconfirmed", round 2 item
    // 3) vs 409 (confirmed, but its content is still live or it is already
    // resolved), never to gate the mutation (which already ran, or didn't,
    // above).
    const candidate = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => orphanedDsaNoticeCandidate(c, id));
    return candidate.exists ? errorResponse("DSA_NOTICE_NOT_ORPHANED", 409) : errorResponse("NOT_FOUND", 404);
  }

  // ⚠️ AFTER the commit, same waitUntil discipline as the author/reporter
  // notices in handleAdminDecision above — a lost Postmark send must not turn
  // an already-durable close into a 500.
  ctx.waitUntil(
    sendDsaOrphanedOutcome(env, closed.reporterEmail, { kind: closed.kind, targetLabel: closed.targetLabel }).then(
      (sent) => {
        if (!sent) console.error("dsa orphaned-notice outcome not sent", { noticeId: id });
      },
    ),
  );

  return new Response(null, { status: 204 });
}
