/**
 * `GET /media/restricted/:sha256` — serves media that #61's visibility hook
 * moved out of the public bucket, after re-checking (on EVERY request, never
 * cached) whether the requester may currently see the post/comment the media
 * belongs to.
 *
 * ⚠️ ONE VISIBILITY CHECK, REUSED — NOT A SEPARATE ACL (PM review, item 4).
 * This route does not own its own notion of "who can see what"; it asks
 * exactly the same two questions the existing read paths already answer:
 * "is the requester this content's author" (GET /posts/:id's own predicate)
 * and "is the requester an Access-verified admin" (the moderation queue's
 * gate). A legally-held key (src/media/legal-hold.ts) is the one exception:
 * neither of those is sufficient, and only an approved two-person grant
 * (`media_access_requests`) serves it.
 *
 * ⚠️ STREAMED, NOT A SIGNED URL. One request = one fresh state check = one
 * `moderation_actions` log row. A signed URL usable for its TTL would let one
 * authorization cover several unlogged fetches — see the design note on #61.
 */
import { readCurrentSession } from "../auth/pipeline";
import { requireAdmin } from "../admin/require-admin";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import { recordModerationAction } from "../moderation/actions";
import { isKeyLegallyHeld } from "../media/legal-hold";
import { mediaKeysReferencedBy } from "../media/reachability";
import { r2KeyForSha256 } from "../media/key-pattern";

import type { RouteParams } from "../routing";

const SHA256_RE = /^[0-9a-f]{64}$/;

function notFound(): Response {
  return errorResponse("NOT_FOUND", 404);
}

/** Same shape as `Client`'s query row for the ownership check. */
async function authorOwns(
  env: Env,
  ctx: ExecutionContext,
  subject: "post" | "comment",
  subjectId: string,
  userId: string,
): Promise<boolean> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rowCount } =
      subject === "post"
        ? await c.query(`SELECT 1 FROM posts WHERE id = $1 AND author_id = $2`, [subjectId, userId])
        : await c.query(`SELECT 1 FROM comments WHERE id = $1 AND author_id = $2`, [subjectId, userId]);
    return (rowCount ?? 0) > 0;
  });
}

async function serveObject(bucket: R2Bucket, key: string): Promise<Response> {
  const object = await bucket.get(key);
  if (object === null) return notFound();
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "image/webp",
      // ⚠️ NEVER cached — a shared or browser cache holding this defeats the
      // whole point of a fresh per-request check.
      "cache-control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleGetRestrictedMedia(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
): Promise<Response> {
  const sha256 = params.sha256;
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) return notFound();
  const r2Key = r2KeyForSha256(sha256);
  const url = new URL(request.url);

  const legallyHeld = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => isKeyLegallyHeld(c, r2Key));

  if (legallyHeld) {
    // ⚠️ `notFound()`, NOT the admin gate's own 401 — this route's convention
    // throughout is "zero rows -> 404, never a role-revealing status" (same
    // reasoning as posts.ts's own-post read). A legal hold is the tier where
    // that matters most: it must not tell an unauthorized caller anything
    // about who is or is not allowed near this object.
    const admin = await requireAdmin(request, env);
    if (admin instanceof Response) return notFound();

    const grantId = url.searchParams.get("grantId");
    if (grantId === null) return notFound();

    const grant = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{
        requested_by: string;
        approved_by: string | null;
        expires_at: Date | null;
      }>(
        `SELECT requested_by, approved_by, expires_at
           FROM media_access_requests WHERE id = $1 AND r2_key = $2`,
        [grantId, r2Key],
      );
      return rows[0] ?? null;
    });

    const now = Date.now();
    const usable =
      grant !== null &&
      grant.approved_by !== null &&
      grant.approved_by !== grant.requested_by && // TWO DISTINCT hands, always
      grant.expires_at !== null &&
      grant.expires_at.getTime() > now &&
      (admin.email === grant.requested_by || admin.email === grant.approved_by); // only the two parties

    if (!usable) return notFound();

    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      recordModerationAction(c, {
        actorAdmin: admin.email,
        action: "media_access",
        reason: `Legal-hold media access via grant ${grantId}`,
        subjectLabel: r2Key,
      }),
    );

    return serveObject(env.MEDIA_RESTRICTED, r2Key);
  }

  // Non-legal (auto-hide pending review, or a moderator's keep_hidden/remove):
  // the requester must be the content's author OR an Access-verified admin,
  // AND the subject they name must actually reference this key.
  const subject = url.searchParams.get("subject");
  const subjectId = url.searchParams.get("subjectId");
  if ((subject !== "post" && subject !== "comment") || subjectId === null) return notFound();

  const referencedKeys = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    mediaKeysReferencedBy(c, subject, subjectId),
  );
  if (!referencedKeys.includes(sha256)) return notFound();

  let actorAdmin: string | null = null;
  const sessionOrFailure = await readCurrentSession(env, request, () => notFound());
  if (!(sessionOrFailure instanceof Response) && (await authorOwns(env, ctx, subject, subjectId, sessionOrFailure.userId))) {
    // author-owns-it — allowed, no admin identity to log.
  } else {
    const admin = await requireAdmin(request, env);
    if (admin instanceof Response) return notFound(); // neither author nor admin
    actorAdmin = admin.email;
  }

  if (actorAdmin !== null) {
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      recordModerationAction(c, {
        actorAdmin,
        action: "media_access",
        reason: "Admin viewed hidden content's media",
        postId: subject === "post" ? subjectId : undefined,
        commentId: subject === "comment" ? subjectId : undefined,
        subjectLabel: r2Key,
      }),
    );
  }

  return serveObject(env.MEDIA_RESTRICTED, r2Key);
}
