/**
 * Notice outbox PR 3 — the moderators' undelivered-notices list and resend.
 * Same Access trust domain and inline-checkOrigin-then-requireAdmin shape as
 * routes/admin-appeals.ts (see handleAdminDecision for why the origin check
 * comes first on a mutation).
 */
import { checkOrigin } from "../auth/csrf";
import { verificationLinkOrigin } from "../auth/email-verify";
import { requireAdmin } from "../admin/require-admin";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import { listUndeliveredNotices, resendNotice } from "../moderation/notice-resend";

import type { RouteParams } from "../routing";
import type { AdminUndeliveredNoticesResponse } from "@thinkersjournal/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** `GET /admin/notices/undelivered` — every `undeliverable` notice, newest first (bounded). */
export async function handleAdminListUndeliveredNotices(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const notices = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => listUndeliveredNotices(c));
  const body: AdminUndeliveredNoticesResponse = { notices };
  return json(body);
}

/**
 * `POST /admin/notices/:id/resend` — return one undeliverable notice to
 * `pending` with fresh tokens; the cron drain sends it. 404 for an unknown id or
 * a row that is not `undeliverable`; 409 NOT_RESENDABLE when nobody can receive it.
 */
export async function handleAdminResendNotice(
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

  const origin = verificationLinkOrigin(request);
  const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => resendNotice(c, id, origin));
  switch (outcome.kind) {
    case "not_found":
      return errorResponse("NOT_FOUND", 404);
    case "not_resendable":
      return errorResponse("NOT_RESENDABLE", 409);
    case "resent":
      // Counts and the row id only: never a body, subject, address or handle.
      console.log("moderation notice resent", { id });
      return json({ id });
  }
}
