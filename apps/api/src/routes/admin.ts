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
import { requireAdmin } from "../admin/require-admin";
import { withClient } from "../db/client";
import { listOpenQueue } from "../moderation/queue";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  if (
    (subject !== "post" && subject !== "comment") ||
    typeof subjectId !== "string" || !UUID_RE.test(subjectId) ||
    typeof decision !== "string" || !DECISIONS.includes(decision as DecisionKind) ||
    // The statement of reasons is DSA-required and is shown to the author:
    // whitespace is not a reason.
    typeof reason !== "string" || reason.trim() === ""
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

  // ⚠️ AFTER the commit and OUTSIDE the response path. The decision is already
  // durable; a Postmark outage must not turn a successful moderation action
  // into a 500. See R5.
  ctx.waitUntil(
    sendModerationNotice(env, result.authorEmail, decision as DecisionKind, reason.trim()),
  );

  return new Response(JSON.stringify({ actionId: result.actionId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
