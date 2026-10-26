// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * `GET /dmca-counter?token=` and `POST /dmca-counter` — the author's DMCA
 * counter-notice (ROADMAP R9; policy section 3). The credential is the single-use
 * token in the takedown email, so there is no session, no Turnstile and no account
 * requirement: an author whose account was suspended can still answer a notice.
 *
 * The GET only PEEKS (a mail client's prefetch must not use the token up); the POST
 * files the counter-notice. Origin check first, then a per-IP rate limit on
 * DSA_LIMITER (key prefix `dmca-counter:`), then the transaction.
 */
import { DmcaCounterInput } from "@thinkersjournal/shared";

import { checkOrigin } from "../auth/csrf";
import { enforceRateLimit } from "../auth/ratelimit";
import { withClient } from "../db/client";
import { clientIp } from "../http/client-ip";
import { errorResponse } from "../http/errors";
import { fileCounterNotice, peekCounterToken } from "../moderation/dmca-counter";

/** The one failure for every unhappy token path: unknown, used and expired look alike. */
function invalidToken(): Response {
  return errorResponse("INVALID_TOKEN", 400);
}

export async function handlePeekDmcaCounter(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (token === null || token === "" || token.length > 200) return invalidToken();
  const target = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => peekCounterToken(c, token));
  if (target === null) return invalidToken();
  return new Response(JSON.stringify(target), { status: 200, headers: { "content-type": "application/json" } });
}

export async function handleFileDmcaCounter(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!checkOrigin(env, request)) return errorResponse("FORBIDDEN", 403);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = DmcaCounterInput.safeParse(raw);
  if (!parsed.success) {
    // Only field NAMES are echoed, never the submitted values.
    return errorResponse("INVALID_INPUT", 400, {
      fields: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    });
  }

  const ip = clientIp(request);
  const limited = await enforceRateLimit(env.DSA_LIMITER, `dmca-counter:${ip ?? "unknown"}`, {
    route: "/dmca-counter",
    bucket: "ip",
    ip,
  });
  if (limited !== null) return limited;

  const { token, authorName, authorAddress, authorPhone, signature } = parsed.data;
  const filed = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    fileCounterNotice(c, { token, authorName, authorAddress, authorPhone, signature }),
  );
  if (!filed) return invalidToken();
  return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
}
