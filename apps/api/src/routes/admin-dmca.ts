// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The Access-gated admin surface for DMCA notices (ROADMAP R9): the list of
 * confirmed notices, and a moderator's two decisions. Same trust domain and
 * conventions as the DSA admin routes in routes/admin.ts: `requireAdmin` on
 * every route, an inline `checkOrigin` on the mutating ones, UUIDs validated
 * before use. The decisions themselves are in moderation/dmca-decisions.ts.
 */
import { checkOrigin } from "../auth/csrf";
import { verificationLinkOrigin } from "../auth/email-verify";
import { requireAdmin } from "../admin/require-admin";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import { afterContentDecision } from "../moderation/after-content-decision";
import { listOpenDmcaNotices, rejectDmcaNotice, takedownDmcaNotice, type DmcaRefusal } from "../moderation/dmca-decisions";
import type { RouteParams } from "../routing";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `GET /admin/dmca-notices` — every confirmed notice awaiting a decision, oldest first. */
export async function handleListDmcaNotices(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const notices = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => listOpenDmcaNotices(c));
  return new Response(
    JSON.stringify({ notices: notices.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** One status for each refusal: 404 for no such confirmed notice, 409 for the rest. */
function refusal(r: DmcaRefusal): Response {
  if (r.kind === "not_found") return errorResponse("NOT_FOUND", 404);
  return errorResponse(r.kind === "target_gone" ? "DMCA_TARGET_GONE" : "DMCA_NOT_PENDING", 409);
}

/**
 * `POST /admin/dmca-notices/:id/takedown` — remove the material. The ruling, the
 * notice's state, the author's notice and the claimant's outcome commit together;
 * the cache purge and media move follow the commit, as for any content ruling.
 */
export async function handleDmcaTakedown(
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

  const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    takedownDmcaNotice(c, { noticeId: id, actorAdmin: admin.email, origin: verificationLinkOrigin(request) }),
  );
  if (outcome.kind !== "ok") return refusal(outcome);

  await afterContentDecision(env, ctx, { subject: outcome.value.subject, result: outcome.value.result });
  return new Response(JSON.stringify({ actionId: outcome.value.result.actionId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** `POST /admin/dmca-notices/:id/reject` — body `{ reason }`, shown to the claimant. */
export async function handleDmcaReject(
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const reason = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["reason"] : undefined;
  if (typeof reason !== "string" || reason.trim() === "" || reason.length > 2000) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["reason"] });
  }

  const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    rejectDmcaNotice(c, { noticeId: id, actorAdmin: admin.email, reason: reason.trim() }),
  );
  if (outcome.kind !== "ok") return refusal(outcome);
  return new Response(null, { status: 204 });
}
