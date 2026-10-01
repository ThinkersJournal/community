/**
 * `POST /dsa-notice` — DSA Art. 16 notice-and-action intake (spec §8,
 * decision #6, part of #113).
 *
 * Unauthenticated, same reasoning as `routes/forgot-password.ts`: anyone,
 * registered or not, must be able to file a notice. The reporter proves a
 * working inbox by confirming via the emailed link (a later task owns the
 * `/dsa-notice/confirm` redemption route) — nothing in THIS route stamps
 * `email_verified_at`.
 *
 * ⚠️ AC-1: this route never touches `reports` or `hidden_at` — see
 * `src/moderation/dsa-notices.ts`'s own header. A notice is queue input for a
 * human only, never an auto-hide signal.
 *
 * ⚠️ `createDsaNotice` returns `null` when the target is not publicly visible
 * (hidden, draft, deleted, or simply nonexistent) — EVERY one of those cases
 * gets the SAME `404 NOT_FOUND`, so a notice against private state can never
 * be distinguished from a notice against nothing at all.
 */
import { DsaNoticeInput } from "@thinkersjournal/shared";

import { verificationLinkOrigin, escapeHtml } from "../auth/email-verify";
import { checkOrigin } from "../auth/csrf";
import { postmarkSend } from "../auth/postmark";
import { enforceRateLimit } from "../auth/ratelimit";
import { verifyTurnstile } from "../auth/turnstile";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import {
  confirmDsaNotice,
  createDsaNotice,
  DSA_CONFIRM_WINDOW_DAYS,
  peekDsaToken,
  TEST_LAST_DSA_TOKEN_KEY,
} from "../moderation/dsa-notices";

/** The single failure response for EVERY unhappy TOKEN path on either route
 * below: missing, unknown, already-confirmed and expired all look identical —
 * same "do not confirm what a guessed token means" reasoning as
 * `verify-email.ts`'s `invalidToken`. */
function invalidToken(): Response {
  return errorResponse("INVALID_TOKEN", 400);
}

export async function handleDsaNotice(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // ---- 1. Origin (CSRF) — before ANY parsing -------------------------------
  if (!checkOrigin(env, request)) {
    return errorResponse("FORBIDDEN", 403);
  }

  // ---- 2. Parse + validate --------------------------------------------------
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = DsaNoticeInput.safeParse(raw);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, {
      fields: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    });
  }
  const { turnstileToken, postId, commentId, reason, statement, reporterName, reporterEmail } =
    parsed.data;
  const input = { postId, commentId, reason, statement, reporterName, reporterEmail };

  // ---- 3. Rate limit — TWO buckets, same reasoning as signup.ts's (a)/(b)
  // pair (see its own comment, which this mirrors): it runs AFTER parsing
  // because both keys need the email. Every real request arrives over the
  // web→api Service Binding, where whether `CF-Connecting-IP` survives the
  // hop is unverified — same `?? "unknown"` placeholder as signup, so an
  // absent header still gives every (ip, email) pair its own bucket rather
  // than collapsing all reporters into one.
  //
  //   (a) `ip:email` — one IP cannot spray/confirmation-mail-bomb many
  //       reporter addresses.
  //   (b) `email`    — one ADDRESS has a ceiling no matter how many IPs send
  //       notices naming it as the reporter. (a) alone does NOT buy this: N
  //       IPs each get their OWN bucket against the same email, so N IPs
  //       trivially defeat (a) and can still flood one victim's inbox with
  //       confirmation mail (round-1 fix wrongly claimed the ip:email key
  //       "bounds one IP spraying many reporter emails" and stopped there —
  //       that sentence was never a claim about MANY IPs against ONE email,
  //       and round 2 adds the bucket that actually bounds that).
  //
  // `reporterEmail` is the PARSED value (DsaNoticeInput already lowercases
  // it) — do NOT rebuild either key from the raw request body, for the same
  // case-folding reason signup.ts documents.
  const clientIp = request.headers.get("CF-Connecting-IP");
  const ipLimited = await enforceRateLimit(
    env.DSA_LIMITER,
    `${clientIp ?? "unknown"}:${reporterEmail}`,
  );
  if (ipLimited !== null) return ipLimited;
  const emailLimited = await enforceRateLimit(env.DSA_LIMITER, `email:${reporterEmail}`);
  if (emailLimited !== null) return emailLimited;

  // ---- 4. Turnstile ----------------------------------------------------------
  let turnstileOk: boolean;
  try {
    turnstileOk = await verifyTurnstile(env, turnstileToken, clientIp ?? undefined);
  } catch (err) {
    console.error("turnstile verification errored", err);
    turnstileOk = false;
  }
  if (!turnstileOk) {
    return errorResponse("FORBIDDEN", 403);
  }

  // ---- 5. Insert (FRESH), ONLY if the target is publicly visible ------------
  const result = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => createDsaNotice(c, input));
  if (result === null) {
    return errorResponse("NOT_FOUND", 404);
  }

  // TEST-ONLY — see TEST_LAST_DSA_TOKEN_KEY's own comment. Identical gate and
  // shape to createResetToken's stash (src/auth/password-reset.ts).
  if (env.TEST_ROUTES === "1") {
    await env.SESSIONS.put(TEST_LAST_DSA_TOKEN_KEY, result.token, {
      expirationTtl: DSA_CONFIRM_WINDOW_DAYS * 24 * 60 * 60,
    });
  }

  // ---- 6. Mail the confirmation link — DISPATCHED, not awaited ---------------
  const confirmUrl = `${verificationLinkOrigin(request)}/dsa-notice/confirm?token=${encodeURIComponent(result.token)}`;
  const targetKind = input.postId !== undefined ? "post" : "comment";
  ctx.waitUntil(
    postmarkSend(env, {
      from: "noreply@thinkersjournal.com",
      to: input.reporterEmail,
      subject: "Confirm your report to Thinkers Journal",
      textBody: `You reported a ${targetKind} on Thinkers Journal.\n\nTo confirm this report, open this link:\n\n${confirmUrl}\n\nIf you did not send this, ignore this email: nothing happens unless you confirm.`,
      htmlBody: `<p>You reported a ${escapeHtml(targetKind)} on Thinkers Journal.</p><p>To confirm this report, open this link:</p><p><a href="${escapeHtml(confirmUrl)}">${escapeHtml(confirmUrl)}</a></p><p>If you did not send this, ignore this email: nothing happens unless you confirm.</p>`,
      stream: "outbound",
    }).then((ok) => {
      if (!ok) {
        console.error("dsa-notice confirmation email failed to send", { noticeId: result.id });
      }
    }),
  );

  return new Response(null, { status: 202 });
}

/**
 * `GET /dsa-notice/confirm?token=` — a safe-to-retry PEEK: does it exist,
 * inside the `DSA_CONFIRM_WINDOW_DAYS` window? Never mutates, so a reporter's
 * mail client prefetching the link (or a user clicking it twice) costs
 * nothing and burns nothing. ⚠️ M1 (final-review fix): a hash that is already
 * CONFIRMED but still inside the window is also "valid" here — see
 * `peekDsaToken`'s own header — so a double submit/refresh/re-opened link
 * after a successful confirm shows the same success page, not
 * `INVALID_TOKEN`. The actual confirmation is the POST below.
 */
export async function handlePeekDsaToken(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (token === null || token === "") {
    return invalidToken();
  }

  const ok = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => peekDsaToken(c, token));
  if (!ok) {
    return invalidToken();
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * `POST /dsa-notice/confirm` — redeems the token: stamps `email_verified_at`
 * exactly once. ⚠️ AC-1: this (and everything it calls) never touches
 * `reports`, `hidden_at`, or `maybeAutoHide` — see
 * `src/moderation/dsa-notices.ts`'s `confirmDsaNotice`.
 */
export async function handleConfirmDsaNotice(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // ---- 1. Origin (CSRF) — before ANY parsing, same shape as the intake route
  if (!checkOrigin(env, request)) {
    return errorResponse("FORBIDDEN", 403);
  }

  // ---- 2. Parse ---------------------------------------------------------
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { token?: unknown }).token !== "string" ||
    (raw as { token: string }).token === ""
  ) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["token"] });
  }
  const { token } = raw as { token: string };

  // ---- 3. Redeem (FRESH) --------------------------------------------------
  const confirmed = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => confirmDsaNotice(c, token));
  if (!confirmed) {
    return invalidToken();
  }

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
