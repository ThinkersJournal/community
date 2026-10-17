/**
 * The security admin routes (security-alerting spec §2.6 N6, R4, F2). Same
 * trust domain as routes/admin.ts: Cloudflare Access via `requireAdmin`. Both
 * are GETs, so neither touches the mutating pipeline.
 *
 * THE AUDIT ROW NEVER NAMES THE USER (R4). A successful resolution appends a
 * `moderation_actions` row carrying the admin's identity and the REF, with no
 * `subject_user_id`; once the ref expires (7 days) nothing links the two.
 * Paging the held list writes no row: it shows refs, not users.
 */
import { HELD_ROW_CAP, type AdminSecurityRefResponse, type SignalClass } from "@thinkersjournal/shared";

import { requireAdmin } from "../admin/require-admin";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import { recordModerationAction } from "../moderation/actions";

import type { RouteParams } from "../routing";

const REF_RE = /^[0-9a-f]{32}$/;
/** A held `subject_key` is `signal|subject`: bounded, and never more than this. */
const MAX_AFTER_LENGTH = 512;
export const SECURITY_REF_RESOLVED_REASON = "Security alert reference looked up by an administrator";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function isHeldClass(value: string): value is SignalClass {
  return Object.hasOwn(HELD_ROW_CAP, value) && HELD_ROW_CAP[value as SignalClass] > 0;
}

/** `GET /admin/security/account-ref/:ref`. Unknown and expired refs answer the SAME 404 and write nothing. */
export async function handleAdminSecurityRef(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const ref = params.ref ?? "";
  if (!REF_RE.test(ref)) return errorResponse("NOT_FOUND", 404);
  const userId = await env.SECURITY_LEDGER.getByName("ledger").resolveRef(ref);
  if (userId === null) return errorResponse("NOT_FOUND", 404);
  const handle = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    await recordModerationAction(c, {
      actorAdmin: admin.email,
      action: "security_ref_resolved",
      reason: SECURITY_REF_RESOLVED_REASON,
      internalNote: ref,
    });
    const { rows } = await c.query<{ username: string }>(
      "SELECT pr.username FROM profiles pr JOIN users u ON u.id = pr.user_id WHERE u.id = $1 AND u.anonymised_at IS NULL",
      [userId],
    );
    return rows[0]?.username ?? null;
  });
  const body: AdminSecurityRefResponse = { userId, handle };
  return json(body);
}

/** `GET /admin/security/held?class=<class>&after=<subject_key>`: one page of one class, key order. */
export async function handleAdminSecurityHeld(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const url = new URL(request.url);
  const signalClass = url.searchParams.get("class") ?? "account";
  const after = url.searchParams.get("after") ?? "";
  if (!isHeldClass(signalClass) || after.length > MAX_AFTER_LENGTH) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["class", "after"] });
  }
  const page = await env.SECURITY_LEDGER.getByName("ledger").listHeld(signalClass, after);
  // A cursor naming a ref that was pruned between pages cannot be resumed: the admin restarts the walk.
  if (page === null) return errorResponse("INVALID_INPUT", 400, { fields: ["after"] });
  return json(page);
}
