import { checkOrigin } from "../auth/csrf";
import { readCurrentSession, runMutatingPipeline } from "../auth/pipeline";
import { BEGIN_BOUNDED_TX, withClient } from "../db/client";
import { isInvalidTextRepresentation } from "../db/errors";
import { errorResponse } from "../http/errors";
import { consumeActionToken, peekActionToken } from "../moderation/action-tokens";
import { describeAppealTarget, fileAppeal, type FileAppealOutcome } from "../moderation/appeals";

import type { RouteParams } from "../routing";

const MAX_BODY = 5000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function refusal(o: Exclude<FileAppealOutcome, { kind: "filed" }>): Response {
  switch (o.kind) {
    case "not_found": return errorResponse("NOT_FOUND", 404);
    case "not_appealable": return errorResponse("NOT_APPEALABLE", 409);
    case "window_closed": return errorResponse("APPEAL_WINDOW_CLOSED", 409);
    case "exists": return errorResponse("APPEAL_EXISTS", 409);
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : errorResponse("INVALID_INPUT", 400);
}

const validBody = (b: unknown): b is string => typeof b === "string" && b.trim() !== "" && b.length <= MAX_BODY;

/**
 * ⚠️ NEITHER TOKEN ROUTE BELOW RATE-LIMITS. Same reasoning as
 * `reset-password.ts`'s header (lines 16-25): the token is 32 bytes of
 * CSPRNG output (256 bits), single-use and time-boxed — guessing it is not a
 * viable attack regardless of how many attempts are allowed, so a
 * request-volume limiter would defend nothing a limiter is good at defending.
 * The entropy IS the defense.
 */

/** GET /appeals/token?token= — PEEK ONLY (Review Focus 2). */
export async function handlePeekAppealToken(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const target = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const t = await peekActionToken(c, token, "appeal");
    return t === null ? null : describeAppealTarget(c, t.actionId);
  });
  // `target === null` covers two different causes on purpose: an unknown/
  // expired/wrong-purpose token (peekActionToken returned null), AND a
  // genuine token whose action is no longer appealable (describeAppealTarget
  // returned null — e.g. a user_terminate action, #114). Both get the SAME
  // 400 INVALID_TOKEN: telling them apart would let a caller learn "this
  // token is real but its action isn't appealable" from a bare peek, which
  // is more than a token holder needs to know.
  return target === null ? errorResponse("INVALID_TOKEN", 400) : json({ target });
}

/** POST /appeals/by-token — no session; the token is the authority. */
export async function handleAppealByToken(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!checkOrigin(env, request)) return errorResponse("FORBIDDEN", 403);
  const b = await readBody(request);
  if (b instanceof Response) return b;
  if (typeof b["token"] !== "string") return errorResponse("INVALID_INPUT", 400, { fields: ["token"] });
  if (!validBody(b["body"])) return errorResponse("INVALID_INPUT", 400, { fields: ["body"] });
  const token = b["token"];
  const body = (b["body"] as string).trim();

  const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c): Promise<FileAppealOutcome | "bad_token"> => {
    await c.query(BEGIN_BOUNDED_TX);
    try {
      // ⚠️ B3: consume refuses an anonymised account, and its users-row lock
      // holds until the COMMIT/ROLLBACK below, so fileAppeal runs against a
      // live account.
      const t = await consumeActionToken(c, token, "appeal");
      if (t === null) {
        await c.query("ROLLBACK");
        return "bad_token";
      }
      const filed = await fileAppeal(c, { actionId: t.actionId, appellantId: t.userId, body });
      // ⚠️ Review Focus 3: a refused filing must not burn the token.
      await c.query(filed.kind === "filed" ? "COMMIT" : "ROLLBACK");
      return filed;
    } catch (err) {
      try { await c.query("ROLLBACK"); } catch { /* the root error below is the useful one */ }
      throw err;
    }
  });
  if (outcome === "bad_token") return errorResponse("INVALID_TOKEN", 400);
  if (outcome.kind !== "filed") return refusal(outcome);
  return json({ appealId: outcome.appealId }, 201);
}

/** POST /appeals — the signed-in path (barred sessions never get here: the pipeline answers ACCOUNT_BARRED). */
export async function handleAppealSignedIn(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const b = await readBody(request);
  if (b instanceof Response) return b;
  if (typeof b["actionId"] !== "string") return errorResponse("INVALID_INPUT", 400, { fields: ["actionId"] });
  if (!validBody(b["body"])) return errorResponse("INVALID_INPUT", 400, { fields: ["body"] });
  const actionId = b["actionId"];
  const body = (b["body"] as string).trim();
  let outcome: FileAppealOutcome;
  try {
    outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      fileAppeal(c, { actionId, appellantId: result.session.userId, body }),
    );
  } catch (err) {
    // A malformed uuid is a 404, exactly as posts.ts handles it.
    if (isInvalidTextRepresentation(err)) return errorResponse("NOT_FOUND", 404);
    throw err;
  }
  if (outcome.kind !== "filed") return refusal(outcome);
  return json({ appealId: outcome.appealId }, 201);
}

/** GET /appeals/for-post/:postId — the editor banner's link target. */
export async function handleAppealForPost(request: Request, env: Env, ctx: ExecutionContext, params: RouteParams): Promise<Response> {
  const session = await readCurrentSession(env, request, () => errorResponse("LOGIN_REQUIRED", 401));
  if (session instanceof Response) return session;
  try {
    return await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      // ⚠️ B3/minor(2): the JOIN's `u.anonymised_at IS NULL` is a second,
      // independent guard — a surviving session (epoch not yet bumped) for an
      // account the scrub has already anonymised must read NOTHING here, same
      // "no path reaches a deleted account" guarantee as the action tokens.
      const { rows: own } = await c.query<{ hidden: boolean }>(
        `SELECT p.hidden_at IS NOT NULL AS hidden FROM posts p
           JOIN users u ON u.id = p.author_id AND u.anonymised_at IS NULL
          WHERE p.id = $1 AND p.author_id = $2`,
        [params.postId, session.userId],
      );
      if (own.length === 0) return errorResponse("NOT_FOUND", 404);
      // ⚠️ The decision GOVERNING visibility now: the latest content_* row of
      // ANY kind, restore included. A keep_hidden/remove that a later restore
      // reversed is not appealable, and neither is anything on a visible post.
      // A post hidden only by auto-hide has no decision yet: nothing to appeal.
      // `id DESC` is a deterministic tie-break for two decisions landing in
      // the same instant (minor 7) — `created_at` alone cannot order them.
      const { rows } = await c.query<{ id: string; action: string }>(
        `SELECT id, action FROM moderation_actions
          WHERE post_id = $1 AND action LIKE 'content\\_%'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [params.postId],
      );
      const latest = rows[0];
      const governing =
        own[0]!.hidden && latest !== undefined && (latest.action === "content_keep_hidden" || latest.action === "content_remove")
          ? latest.id
          : null;
      return json({ target: governing === null ? null : await describeAppealTarget(c, governing) });
    });
  } catch (err) {
    if (isInvalidTextRepresentation(err)) return errorResponse("NOT_FOUND", 404);
    throw err;
  }
}
