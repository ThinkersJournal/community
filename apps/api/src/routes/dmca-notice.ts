// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * `POST /dmca-notice` and `/dmca-notice/confirm` — DMCA takedown notice intake
 * (ROADMAP R9; design note docs/superpowers/specs/2026-10-25-dmca-flow-design.md).
 *
 * Every property of `routes/dsa-notice.ts` carries over, and its comments are the
 * reasoning: unauthenticated; origin check before parsing; two rate-limit buckets
 * (ip:email and email); Turnstile; the single 404 for any non-public target; the
 * confirmation mail dispatched, not awaited. A notice stays INERT (AC-1) until the
 * complainant confirms, and even then it hides nothing until a moderator decides.
 *
 * The limiter binding is DSA_LIMITER, with a `dmca:` key prefix so the two
 * intakes cannot spend each other's quota.
 */
import { DmcaNoticeInput, DMCA_CONFIRM_WINDOW_DAYS, type DmcaNoticeInputT } from "@thinkersjournal/shared";

import { checkOrigin } from "../auth/csrf";
import { escapeHtml, verificationLinkOrigin } from "../auth/email-verify";
import { postmarkSend } from "../auth/postmark";
import { enforceRateLimit } from "../auth/ratelimit";
import { verifyTurnstile } from "../auth/turnstile";
import { withClient } from "../db/client";
import { clientIp } from "../http/client-ip";
import { errorResponse } from "../http/errors";
import { parsePostUrl } from "../moderation/content-url";
import {
  confirmDmcaNotice,
  createDmcaNotice,
  peekDmcaToken,
  TEST_LAST_DMCA_TOKEN_KEY,
} from "../moderation/dmca-notices";

/** The one failure for every unhappy token path: missing, unknown and expired look alike. */
function invalidToken(): Response {
  return errorResponse("INVALID_TOKEN", 400);
}

type ParsedNotice = DmcaNoticeInputT;

/** Steps 2: parse and validate the body. A `Response` is the refusal; otherwise the notice and the pasted-URL target. */
async function parseNotice(
  request: Request,
): Promise<Response | { readonly data: ParsedNotice; readonly urlTarget: ReturnType<typeof parsePostUrl> }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = DmcaNoticeInput.safeParse(raw);
  if (!parsed.success) {
    // Only field NAMES are echoed, never the submitted values.
    return errorResponse("INVALID_INPUT", 400, {
      fields: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    });
  }
  const urlTarget = parsed.data.contentUrl === undefined ? null : parsePostUrl(parsed.data.contentUrl);
  if (parsed.data.contentUrl !== undefined && urlTarget === null) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["contentUrl"] });
  }
  return { data: parsed.data, urlTarget };
}

/**
 * Steps 3 and 4: two rate-limit buckets (the reasoning is dsa-notice.ts's), then
 * Turnstile. Returns the refusal, or `null` to go on.
 */
async function limitAndVerify(env: Env, request: Request, email: string, turnstileToken: string): Promise<Response | null> {
  const ip = clientIp(request);
  const ipLimited = await enforceRateLimit(env.DSA_LIMITER, `dmca:${ip ?? "unknown"}:${email}`, {
    route: "/dmca-notice",
    bucket: "ip:email",
    ip,
  });
  if (ipLimited !== null) return ipLimited;
  const emailLimited = await enforceRateLimit(env.DSA_LIMITER, `dmca-email:${email}`, {
    route: "/dmca-notice",
    bucket: "email",
    ip,
  });
  if (emailLimited !== null) return emailLimited;

  let turnstileOk: boolean;
  try {
    turnstileOk = await verifyTurnstile(env, turnstileToken, ip ?? undefined);
  } catch (err) {
    console.error("turnstile verification errored", err);
    turnstileOk = false;
  }
  return turnstileOk ? null : errorResponse("FORBIDDEN", 403);
}

/** Step 5: insert (FRESH), ONLY if the target is publicly visible. `null` = it is not (the one 404). */
async function insertNotice(
  env: Env,
  ctx: ExecutionContext,
  parsed: { readonly data: ParsedNotice; readonly urlTarget: ReturnType<typeof parsePostUrl> },
): Promise<{ id: string; token: string } | null> {
  const { turnstileToken: _t, contentUrl: _u, ...fields } = parsed.data;
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    let postId = fields.postId;
    if (parsed.urlTarget !== null) {
      const { rows } = await c.query<{ id: string }>(
        `SELECT p.id FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
          WHERE pr.username = $1 AND p.slug = $2 AND p.status = 'published' AND p.hidden_at IS NULL`,
        [parsed.urlTarget.username, parsed.urlTarget.slug],
      );
      // The same single 404 as every other non-public target.
      if (rows[0] === undefined) return null;
      postId = rows[0].id;
    }
    return createDmcaNotice(c, { ...fields, postId });
  });
}

/** Step 6: mail the confirmation link, DISPATCHED and not awaited. */
function mailConfirmation(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  notice: { readonly id: string; readonly token: string },
  to: string,
  targetKind: "post" | "comment",
): void {
  const confirmUrl = `${verificationLinkOrigin(request)}/dmca/confirm?token=${encodeURIComponent(notice.token)}`;
  ctx.waitUntil(
    postmarkSend(env, {
      from: "noreply@thinkersjournal.com",
      to,
      subject: "Confirm your copyright notice to Thinkers Journal",
      textBody: `You sent a copyright (DMCA) notice about a ${targetKind} on Thinkers Journal.\n\nTo confirm it, open this link:\n\n${confirmUrl}\n\nIf you did not send this, ignore this email: nothing happens unless you confirm.`,
      htmlBody: `<p>You sent a copyright (DMCA) notice about a ${escapeHtml(targetKind)} on Thinkers Journal.</p><p>To confirm it, open this link:</p><p><a href="${escapeHtml(confirmUrl)}">${escapeHtml(confirmUrl)}</a></p><p>If you did not send this, ignore this email: nothing happens unless you confirm.</p>`,
      stream: "outbound",
    }).then((ok) => {
      if (!ok) {
        console.error("dmca-notice confirmation email failed to send", { noticeId: notice.id });
      }
    }),
  );
}

export async function handleDmcaNotice(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // 1. Origin (CSRF) — before ANY parsing.
  if (!checkOrigin(env, request)) {
    return errorResponse("FORBIDDEN", 403);
  }
  // 2. Parse + validate.
  const parsed = await parseNotice(request);
  if (parsed instanceof Response) return parsed;
  // 3-4. Rate limit, then Turnstile.
  const refused = await limitAndVerify(env, request, parsed.data.complainantEmail, parsed.data.turnstileToken);
  if (refused !== null) return refused;
  // 5. Insert.
  const result = await insertNotice(env, ctx, parsed);
  if (result === null) {
    return errorResponse("NOT_FOUND", 404);
  }
  // TEST-ONLY seam, same gate and shape as the DSA token stash.
  if (env.TEST_ROUTES === "1") {
    await env.SESSIONS.put(TEST_LAST_DMCA_TOKEN_KEY, result.token, {
      expirationTtl: DMCA_CONFIRM_WINDOW_DAYS * 24 * 60 * 60,
    });
  }
  // 6. Mail the confirmation.
  mailConfirmation(env, ctx, request, result, parsed.data.complainantEmail, parsed.data.commentId === undefined ? "post" : "comment");
  return new Response(null, { status: 202 });
}

/**
 * `GET /dmca-notice/confirm?token=` — a safe-to-retry PEEK (a mail client's
 * prefetch must not burn the token). The confirmation is the POST below.
 */
export async function handlePeekDmcaToken(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (token === null || token === "") {
    return invalidToken();
  }
  const ok = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => peekDmcaToken(c, token));
  if (!ok) {
    return invalidToken();
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** `POST /dmca-notice/confirm` — stamps `email_verified_at` once. Confirms only; hides nothing. */
export async function handleConfirmDmcaNotice(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!checkOrigin(env, request)) {
    return errorResponse("FORBIDDEN", 403);
  }
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

  const confirmed = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => confirmDmcaNotice(c, token));
  if (!confirmed) {
    return invalidToken();
  }
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
