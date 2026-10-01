/**
 * The account half of the enforcement ladder (spec §5, #113 plan A).
 * Same trust domain and the same inline-checkOrigin shape as routes/admin.ts.
 *
 * ⚠️ NOT reachable from the review queue's decision form (spec decision #3):
 * the queue only links here. Content decision and account action are
 * separate, deliberate steps.
 */
import { checkOrigin } from "../auth/csrf";
import { requireAdmin } from "../admin/require-admin";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import { applyAccountAction, loadAccountHistory } from "../moderation/account-actions";
import { sendAccountActionNotice } from "../moderation/notify-account";

import {
  ADMIN_ACCOUNT_ACTIONS,
  DEFAULT_SUSPENSION_HOURS,
  REPORT_REASONS,
  SUSPENSION_HOURS,
  suggestNextRung,
  type AdminAccountActionKind,
  type AdminAccountResponse,
  type SuspensionHours,
} from "@thinkersjournal/shared";

import type { ViolationCategory } from "../moderation/actions";
import type { RouteParams } from "../routing";

interface AccountRow {
  id: string;
  username: string;
  suspended_until: Date | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
}

/** ⚠️ `username` is citext (Review Focus 4). An anonymised account's handle is released, so it 404s (Review Focus 5). */
async function findByHandle(env: Env, ctx: ExecutionContext, handle: string): Promise<AccountRow | null> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<AccountRow>(
      `SELECT u.id, pr.username, u.suspended_until, u.disabled_at, u.disabled_reason
         FROM profiles pr JOIN users u ON u.id = pr.user_id
        WHERE pr.username = $1 AND u.anonymised_at IS NULL`,
      [handle],
    );
    return rows[0] ?? null;
  });
}

export async function handleAdminGetAccount(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const account = await findByHandle(env, ctx, params.handle ?? "");
  if (account === null) return errorResponse("NOT_FOUND", 404);

  const history = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => loadAccountHistory(c, account.id));
  const body: AdminAccountResponse = {
    userId: account.id,
    handle: account.username,
    suspendedUntil: account.suspended_until?.toISOString() ?? null,
    disabledAt: account.disabled_at?.toISOString() ?? null,
    disabledReason: account.disabled_reason,
    history,
    suggestedNext: suggestNextRung(history),
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

export async function handleAdminAccountAction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
): Promise<Response> {
  // ⚠️ ORIGIN FIRST — see routes/admin.ts handleAdminDecision for why Access alone is not enough.
  if (!checkOrigin(env, request)) return errorResponse("FORBIDDEN", 403);
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return errorResponse("INVALID_INPUT", 400);
  const b = body as Record<string, unknown>;
  const action = b["action"];
  const reason = b["reason"];
  const category = b["violationCategory"];
  const hours = b["suspensionHours"] ?? DEFAULT_SUSPENSION_HOURS;
  const confirmBan = b["confirmBan"];

  if (
    typeof action !== "string" || !(ADMIN_ACCOUNT_ACTIONS as readonly string[]).includes(action) ||
    typeof reason !== "string" || reason.trim() === "" ||
    (category !== undefined && !(REPORT_REASONS as readonly unknown[]).includes(category)) ||
    (action === "suspend" && !(SUSPENSION_HOURS as readonly unknown[]).includes(hours)) ||
    // ⚠️ A ban is permanent (barring the CSAM `terminate` path, which has no
    // admin button at all). Require an explicit, separate confirmation on top
    // of the reason text, so a moderator cannot ban by the same one click
    // that would warn or suspend.
    (action === "ban" && confirmBan !== true)
  ) {
    return errorResponse("INVALID_INPUT", 400);
  }
  const kind = action as AdminAccountActionKind;

  const account = await findByHandle(env, ctx, params.handle ?? "");
  if (account === null) return errorResponse("NOT_FOUND", 404);

  // ⚠️ Review Focus 3 — THE EPOCH IS BUMPED TWICE for a bar. BEFORE the
  // commit: if the Durable Object is unreachable we fail here with nothing
  // written, and the moderator retries cleanly. AFTER the commit: a login that
  // completed between the first bump and the commit (the DB did not bar it
  // yet) got a session carrying the new epoch, and this kills it. GET routes
  // check only the epoch, so without the bump a ban would not stick on reads.
  // ⚠️ THE DOUBLE BUMP ALONE DOES NOT CLOSE THE RACE — a login whose own
  // lookup (its step 4) ran before this commit, but whose epoch read (its
  // step 8) also ran before the first bump above, would still mint a session
  // nothing here ever revokes, because mutating-route protection only compares
  // against the epoch, and that session's stamped epoch is already current.
  // What closes it is src/routes/login.ts's own re-read of suspended_until/
  // disabled_at AFTER its epoch read (that file's step 8b) — the double bump
  // here is what makes a session minted ANY time after this commit immediately
  // stale, and the login-side re-read is what catches the narrower window
  // before this commit lands at all. Both are required; neither alone is.
  const bars = kind === "suspend" || kind === "ban";
  if (bars) await env.USER_SECURITY.getByName(account.id).bumpEpoch();

  const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    applyAccountAction(c, {
      userId: account.id,
      kind,
      reason: reason.trim(),
      actorAdmin: admin.email,
      subjectLabel: account.username,
      suspensionHours: kind === "suspend" ? (hours as SuspensionHours) : undefined,
      violationCategory: category as ViolationCategory | undefined,
    }),
  );
  if (outcome.kind === "not_found") return errorResponse("NOT_FOUND", 404);
  if (outcome.kind === "already_disabled") return errorResponse("ACCOUNT_ALREADY_DISABLED", 409);

  if (bars) {
    try {
      await env.USER_SECURITY.getByName(account.id).bumpEpoch();
    } catch (err) {
      // The action is committed; the first bump already killed every session
      // that existed before it. Only a login inside the race window survives.
      console.error("post-commit epoch bump failed", { actionId: outcome.actionId, err });
    }
  }

  // ⚠️ Review Focus 5 — never mail a scrubbed address.
  if (!outcome.anonymised) {
    ctx.waitUntil(
      sendAccountActionNotice(env, outcome.email, {
        kind,
        reason: reason.trim(),
        suspendedUntil: outcome.suspendedUntil ?? undefined,
      }).then((sent) => {
        if (!sent) console.error("account notice not sent", { actionId: outcome.actionId });
      }),
    );
  }

  return new Response(JSON.stringify({ actionId: outcome.actionId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
