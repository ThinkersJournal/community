/**
 * #113 plan B — the moderators' appeal list and its resolution. Same Access
 * trust domain and inline-checkOrigin-then-requireAdmin shape as
 * routes/admin.ts's handleAdminDecision (see that handler for why the origin
 * check comes first).
 */
import { checkOrigin } from "../auth/csrf";
import { escapeHtml } from "../auth/email-verify";
import { postmarkSend } from "../auth/postmark";
import { requireAdmin } from "../admin/require-admin";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import { afterContentDecision } from "../moderation/after-content-decision";
import { listOpenAppeals, resolveAppeal } from "../moderation/appeals";

import type { RouteParams } from "../routing";
import type { AdminAppealResolveResponse, AdminAppealsResponse } from "@thinkersjournal/shared";

// Same shape as routes/admin.ts's and admin-accounts.ts's UUID_RE: a `:id`
// path param is validated to 404 before any query sees it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** `GET /admin/appeals` — every open appeal, oldest first. */
export async function handleAdminListAppeals(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const appeals = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => listOpenAppeals(c));
  const body: AdminAppealsResponse = { appeals };
  return json(body);
}

/** `POST /admin/appeals/:id/resolve` — body `AdminAppealResolveRequest`. */
export async function handleAdminResolveAppeal(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
): Promise<Response> {
  if (!checkOrigin(env, request)) return errorResponse("FORBIDDEN", 403);
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const appealId = params.id;
  if (typeof appealId !== "string" || !UUID_RE.test(appealId)) return errorResponse("NOT_FOUND", 404);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return errorResponse("INVALID_INPUT", 400);
  const b = raw as Record<string, unknown>;
  const decision = b["decision"];
  const reason = b["reason"];
  if ((decision !== "grant" && decision !== "deny") || typeof reason !== "string" || reason.trim() === "") {
    return errorResponse("INVALID_INPUT", 400);
  }
  const trimmed = reason.trim();

  const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    resolveAppeal(c, { appealId, grant: decision === "grant", reason: trimmed, actorAdmin: admin.email }),
  );
  switch (outcome.kind) {
    case "not_found":
    case "content_gone":
      return errorResponse("NOT_FOUND", 404);
    case "already_resolved":
      return errorResponse("APPEAL_RESOLVED", 409);
    case "terminated":
      return errorResponse("NOT_APPEALABLE", 409);
    case "resolved":
      break;
  }

  // Post-commit, as handleAdminDecision: purge, media move, and the DSA
  // reporters whose confirmed notices the restore resolved.
  if (outcome.content !== null && outcome.subject !== null) {
    await afterContentDecision(env, ctx, {
      subject: outcome.subject,
      decision: "restore",
      reason: trimmed,
      result: outcome.content,
    });
  }

  // The outcome to the appellant. Never to an anonymised account (B3).
  const to = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1 AND anonymised_at IS NULL`,
      [outcome.appellantId],
    );
    return rows[0]?.email ?? null;
  });
  if (to !== null) {
    const lead = outcome.outcome === "granted" ? "Your appeal was granted." : "Your appeal was not granted.";
    ctx.waitUntil(
      postmarkSend(env, {
        from: "noreply@thinkersjournal.com",
        to,
        subject: outcome.outcome === "granted" ? "Your appeal was granted" : "Your appeal was not granted",
        textBody: `${lead}\n\nReason given by the moderator:\n\n${trimmed}\n`,
        htmlBody: `<p>${escapeHtml(lead)}</p><p><strong>Reason given by the moderator:</strong></p><p>${escapeHtml(trimmed)}</p>`,
        stream: "outbound",
      }).then((sent) => {
        if (!sent) console.error("appeal outcome not sent", { appealId, actionId: outcome.resolutionActionId });
      }),
    );
  }

  const body: AdminAppealResolveResponse = {
    resolutionActionId: outcome.resolutionActionId,
    sameReviewer: outcome.sameReviewer,
  };
  return json(body);
}
