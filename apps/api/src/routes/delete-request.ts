/**
 * #50 Q4 — a barred user's way to ask for deletion (CireSnave: "can we provide
 * them the ability to dispute their ban and offer the ability to request
 * deletion of the account through that?"). This answers HOW they reach it;
 * WHAT deletion does is unchanged: deletion_requested_at is stamped, and
 * anonymise-accounts.ts gates only on an active legal hold, not on the bar; a
 * banned account is anonymised with a reserved email hash (revised 2026-10-01
 * per PM ruling B, legal-hold spec §4/§4a).
 *
 * ⚠️ GET peeks, POST consumes, POST requires `confirm: true` (Review Focus 2).
 * ⚠️ BARRED RIGHT NOW (pre-flight ruling, T3/T5): the link works only while
 * `isBarred` holds, the same predicate the resend route uses. A lapsed
 * suspension's link gets the SAME 400 INVALID_TOKEN as an expired one, and is
 * left unspent; the signed-in deletion route is that user's path now.
 * ⚠️ NO PATH REACHES A DELETED ACCOUNT (B3): consume refuses an anonymised
 * account and holds its users row until COMMIT; the UPDATE re-checks too.
 * ⚠️ MUST NOT LEAK WHETHER AN ADDRESS IS REGISTERED OR BARRED, same two
 * defenses as forgot-password.ts: the status and body never differ, and the
 * found path's one extra `INSERT` (the minted token) before responding is a
 * timing residual, not a claim of perfect closure — same honesty as that
 * route's own header.
 */
import { DeleteRequestResendInput, DELETE_REQUEST_RESEND_TTL_HOURS } from "@thinkersjournal/shared";
import type { Client } from "pg";

import { isBarred } from "../auth/account-status";
import { checkOrigin } from "../auth/csrf";
import { escapeHtml, verificationLinkOrigin } from "../auth/email-verify";
import { postmarkSend } from "../auth/postmark";
import { enforceRateLimit } from "../auth/ratelimit";
import { verifyTurnstile } from "../auth/turnstile";
import { BEGIN_BOUNDED_TX, withClient } from "../db/client";
import { clientIp } from "../http/client-ip";
import { errorResponse } from "../http/errors";
import { consumeActionToken, mintActionToken, peekActionToken } from "../moderation/action-tokens";
import { DELETE_REQUEST_SENTENCE_AFTER } from "../moderation/notify-account";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Is this live (not anonymised) account barred right now? The same `isBarred` as login and the resend route. */
async function barredNow(c: Client, userId: string): Promise<boolean> {
  const { rows } = await c.query<{ suspended_until: Date | null; disabled_at: Date | null }>(
    `SELECT suspended_until, disabled_at FROM users WHERE id = $1 AND anonymised_at IS NULL`,
    [userId],
  );
  const u = rows[0];
  return u !== undefined && isBarred(u);
}

export async function handlePeekDeleteRequestToken(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const ok = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const t = await peekActionToken(c, token, "delete_request");
    return t !== null && (await barredNow(c, t.userId));
  });
  return ok ? json({ ok: true }) : errorResponse("INVALID_TOKEN", 400);
}

export async function handleDeleteRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!checkOrigin(env, request)) return errorResponse("FORBIDDEN", 403);
  let b: Record<string, unknown>;
  try {
    const raw: unknown = await request.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return errorResponse("INVALID_INPUT", 400);
    b = raw as Record<string, unknown>;
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  if (typeof b["token"] !== "string" || b["confirm"] !== true) return errorResponse("INVALID_INPUT", 400);
  const token = b["token"];

  const recorded = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    await c.query(BEGIN_BOUNDED_TX);
    try {
      const t = await consumeActionToken(c, token, "delete_request");
      // Unknown/expired/spent/wrong-purpose/anonymised, or no longer barred:
      // one answer, and the token is left as it was.
      if (t === null || !(await barredNow(c, t.userId))) {
        await c.query("ROLLBACK");
        return false;
      }
      // COALESCE: a repeat request never pushes the 30-day clock (unlike the
      // signed-in route, which restamps on purpose — here nobody can cancel).
      // `anonymised_at IS NULL` in the same statement (B3).
      const { rowCount } = await c.query(
        `UPDATE users SET deletion_requested_at = COALESCE(deletion_requested_at, now())
          WHERE id = $1 AND anonymised_at IS NULL`,
        [t.userId],
      );
      if ((rowCount ?? 0) === 0) {
        await c.query("ROLLBACK");
        return false;
      }
      await c.query("COMMIT");
      return true;
    } catch (err) {
      try { await c.query("ROLLBACK"); } catch { /* keep the root error */ }
      throw err;
    }
  });
  if (!recorded) return errorResponse("INVALID_TOKEN", 400);
  return json({ recorded: true });
}

export async function handleDeleteRequestResend(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!checkOrigin(env, request)) return errorResponse("FORBIDDEN", 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = DeleteRequestResendInput.safeParse(raw);
  if (!parsed.success) return errorResponse("INVALID_INPUT", 400);
  const { email, turnstileToken } = parsed.data;

  const ip = clientIp(request) ?? "unknown";
  const limited =
    (await enforceRateLimit(env.RESET_LIMITER, `delreq:${ip}:${email}`)) ??
    (await enforceRateLimit(env.RESET_LIMITER, `delreq-email:${email}`));
  if (limited !== null) return limited;

  let human = false;
  try {
    human = await verifyTurnstile(env, turnstileToken, ip === "unknown" ? undefined : ip);
  } catch (err) {
    console.error("turnstile verification errored", err);
  }
  if (!human) return errorResponse("FORBIDDEN", 403);

  const accepted = new Response(null, { status: 202 });

  const minted = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{
      id: string;
      email: string;
      suspended_until: Date | null;
      disabled_at: Date | null;
      action_id: string | null;
    }>(
      `SELECT u.id, u.email, u.suspended_until, u.disabled_at,
              (SELECT ma.id FROM moderation_actions ma
                WHERE ma.subject_user_id = u.id AND ma.action IN ('user_suspend','user_ban','user_terminate')
                ORDER BY ma.created_at DESC LIMIT 1) AS action_id
         FROM users u WHERE u.email = $1 AND u.anonymised_at IS NULL`,
      [email],
    );
    const u = rows[0];
    if (u === undefined || !isBarred(u) || u.action_id === null) return null;
    // ⚠️ B3: the guarded mint re-checks anonymised_at in the INSERT itself,
    // under FOR KEY SHARE. A scrub that committed after the SELECT above
    // yields null here, and no link is sent.
    const token = await mintActionToken(c, {
      actionId: u.action_id,
      userId: u.id,
      purpose: "delete_request",
      ttlMs: DELETE_REQUEST_RESEND_TTL_HOURS * 3600_000,
    });
    return token === null ? null : { token, email: u.email };
  });

  if (minted !== null) {
    const url = `${verificationLinkOrigin(request)}/account/delete-request?token=${encodeURIComponent(minted.token)}`;
    const tail = `It expires in ${DELETE_REQUEST_RESEND_TTL_HOURS} hours and works once. ${DELETE_REQUEST_SENTENCE_AFTER}`;
    // DISPATCHED, not awaited — same reason as forgot-password.ts: awaiting
    // would put the mail latency into the response and leak "found".
    ctx.waitUntil(
      // Mail the STORED address (u.email), not the input: same as
      // forgot-password.ts, and the one that would actually be registered.
      postmarkSend(env, {
        from: "noreply@thinkersjournal.com",
        to: minted.email,
        subject: "Your account deletion link",
        textBody: `To ask for your Thinkers Journal account to be deleted, open this link:\n\n${url}\n\n${tail}`,
        htmlBody: `<p>To ask for your Thinkers Journal account to be deleted, open this link:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>${escapeHtml(tail)}</p>`,
        stream: "outbound",
      }).then((sent) => {
        if (!sent) console.error("delete-request link not sent");
      }),
    );
  }
  return accepted;
}
