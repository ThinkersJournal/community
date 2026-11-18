// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * POST /posts/:id/references (M3.4a): the author asks for a card for a URL on their own post. This is the route over
 * `attachReference` (src/references/attach.ts), which owns every rule (ownership, the 10-card cap, the per-user
 * limiter, reuse of a fresh stored row, the transaction). This file only authenticates, parses, builds the door and
 * translates the typed result.
 *
 * ⚠️ A FAILURE NEVER LOSES THE POST. The post is already saved; a blocked target, a timeout or a bad page comes back
 * as 422 REFERENCE_FAILED with `reason`, and the caller leaves the URL as an ordinary link. The one exception to
 * "not a server error" is `internal` (our own bug, already logged by attachReference): that is 500 REFERENCE_FAILED.
 * `rate_limited` is the one 429 and `post_not_found` the one 404 (the same answer for a stranger's post and a missing
 * one). The door is `productionFetchCtx()` wrapped in the per-origin limiter; nothing here reaches the network itself.
 */
import { AttachReferenceInput } from "@thinkersjournal/shared";

import { runMutatingPipeline } from "../auth/pipeline";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import { attachReference } from "../references/attach";
import { productionFetchCtx } from "../references/guarded-fetch";
import { withOriginLimit } from "../references/origin-limit";
import { registryFromEnv } from "../references/registry";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleAttachReference(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Readonly<Record<string, string>>,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  const postId = params.id ?? "";
  if (!UUID_RE.test(postId)) return errorResponse("INVALID_INPUT", 400, { fields: ["id"] });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = AttachReferenceInput.safeParse(body);
  if (!parsed.success) return errorResponse("INVALID_INPUT", 400, { fields: ["url"] });

  const door = { fetch: withOriginLimit(productionFetchCtx().fetch, env.REF_ORIGIN_LIMITER) };
  const outcome = await withClient(env.HYPERDRIVE_FRESH, ctx, (db) =>
    attachReference(
      db,
      { postId, authorId: userId, url: parsed.data.url },
      { ctx: door, limiter: env.REF_ATTACH_LIMITER, registry: registryFromEnv(env) },
    ),
  );

  if (outcome.ok) {
    return new Response(JSON.stringify({ token: outcome.token, referenceId: outcome.referenceId, reused: outcome.reused }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }
  if (outcome.reason === "post_not_found") return errorResponse("NOT_FOUND", 404);
  if (outcome.reason === "under_moderation") {
    return errorResponse("POST_UNDER_MODERATION", 403, {
      message: "This post is hidden pending review or by moderator decision, and cannot be changed.",
    });
  }
  if (outcome.reason === "rate_limited") return errorResponse("RATE_LIMITED", 429);
  if (outcome.reason === "internal") return errorResponse("REFERENCE_FAILED", 500, { reason: outcome.reason });
  return errorResponse("REFERENCE_FAILED", 422, { reason: outcome.reason });
}

