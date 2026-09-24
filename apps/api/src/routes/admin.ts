/**
 * The Access-gated admin surface (M4 2a).
 *
 * `GET /admin/whoami` is deliberately the whole of 2a's HTTP surface: it proves
 * the gate end to end — JWKS fetch, signature check, issuer/audience/expiry —
 * without inventing a feature the queue module has not designed yet.
 */
import { checkOrigin } from "../auth/csrf";
import { errorResponse } from "../http/errors";
import { applyDecision, type DecisionKind } from "../moderation/decide";
import { sendModerationNotice } from "../moderation/notify-author";
import { purgeTags } from "../cache/purge";
import { purgeTagsFor } from "../moderation/purge-target";
import { requireAdmin } from "../admin/require-admin";
import { withClient } from "../db/client";
import { listOpenQueue } from "../moderation/queue";
import { applyMediaVisibilityChange } from "../media/visibility-hook";
import type { LegalHoldCategory } from "../media/legal-hold";
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
 * ⚠️ Only a human writes a `content_*` action — automation never decides.
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

  if (
    (subject !== "post" && subject !== "comment") ||
    typeof subjectId !== "string" || !UUID_RE.test(subjectId) ||
    typeof decision !== "string" || !DECISIONS.includes(decision as DecisionKind) ||
    // The statement of reasons is DSA-required and is shown to the author:
    // whitespace is not a reason.
    typeof reason !== "string" || reason.trim() === "" ||
    (legalHold !== undefined && typeof legalHold !== "boolean") ||
    (legalHold === true && decision === "restore") ||
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
    }),
  );

  if (result === null) return errorResponse("NOT_FOUND", 404);

  // ⚠️ PURGE AFTER THE COMMIT. Without this a Remove leaves the content served
  // from the edge cache for up to 25 hours (PUBLIC_MAX_AGE + PUBLIC_SWR).
  // Canonical ids come from RETURNING. Awaited; purgeTags never throws. The
  // 404 and the cross-origin 403 above return before this, so they purge nothing.
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
      legalHold === true
        ? {
            category: legalHoldCategory as LegalHoldCategory,
            moderationActionId: result.actionId,
            imposedBy: admin.email,
          }
        : undefined,
  });

  // ⚠️ AFTER the commit and OUTSIDE the response path. The decision is already
  // durable; a Postmark outage must not turn a successful moderation action
  // into a 500. See R5. A dismissal (Restore of never-hidden content) sends
  // nothing — sendModerationNotice owns that rule.
  ctx.waitUntil(
    sendModerationNotice(env, result.authorEmail, {
      decision: decision as DecisionKind,
      wasHidden: result.wasHidden,
      subject,
      postTitle: result.postTitle,
      reason: reason.trim(),
    }).then((sent) => {
      if (!sent) {
        // A lost notice must be findable and re-sendable (R5).
        console.error("moderation notice not sent", { actionId: result.actionId });
      }
    }),
  );

  return new Response(JSON.stringify({ actionId: result.actionId }), {
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
