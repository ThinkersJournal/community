// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Re-acceptance of the Terms (ROADMAP R12; CireSnave 2026-10-25, S27: "build the
 * material-change notice + acceptance record WITH S6"). Signup records the first
 * acceptance (migration 0039, `terms_acceptances`, one row per account and Terms
 * version). When `TERMS_VERSION` changes, a member with no row for the new version
 * is told, and accepting inserts one more row: the older rows stay, so what was
 * agreed and when remains provable.
 *
 *   GET  /account/terms  -> { currentVersion, lastAcceptedVersion, needsAcceptance }
 *   POST /account/terms  -> accepts the current version (idempotent)
 *
 * Nothing is blocked while a member has not re-accepted: this is a notice and a
 * record, not a gate (the Terms drafts say continued use is acceptance, and the
 * guidelines-intentions audit asked for an announcement and a record, not a lockout).
 */
import { SIGNUP_MINIMUM_AGE, TermsAcceptInput, TERMS_VERSION, type TermsStatus } from "@thinkersjournal/shared";

import { readCurrentSession, runMutatingPipeline } from "../auth/pipeline";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function handleTermsStatus(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const session = await readCurrentSession(env, request, () => errorResponse("LOGIN_REQUIRED", 401));
  if (session instanceof Response) return session;

  const rows = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ terms_version: string }>(
      `SELECT terms_version FROM terms_acceptances WHERE user_id = $1 ORDER BY accepted_at DESC, terms_version DESC`,
      [session.userId],
    );
    return rows;
  });
  const status: TermsStatus = {
    currentVersion: TERMS_VERSION,
    lastAcceptedVersion: rows[0]?.terms_version ?? null,
    // Dark until `TERMS_NOTICE` is "1": the notice has no Terms page to point at before R1 (/terms).
    needsAcceptance: env.TERMS_NOTICE === "1" && !rows.some((r) => r.terms_version === TERMS_VERSION),
  };
  return json(status);
}

export async function handleAcceptTerms(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = TermsAcceptInput.safeParse(raw);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, {
      fields: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    });
  }

  // ON CONFLICT DO NOTHING: accepting twice keeps the first time, the evidence that matters.
  await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    await c.query(
      `INSERT INTO terms_acceptances (user_id, terms_version, minimum_age) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, terms_version) DO NOTHING`,
      [userId, TERMS_VERSION, SIGNUP_MINIMUM_AGE],
    );
  });
  return json({});
}
