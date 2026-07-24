/**
 * IN-APP NOTIFICATION READS (M2.3a). Every query scopes to
 * recipient_id = session.userId — that is the IDOR boundary and it lives in the
 * SQL, never in a client-supplied field. Viewer-scoped, no-store, never cached.
 */
import { readCurrentSession, runMutatingPipeline } from "../auth/pipeline";
import { withClient } from "../db/client";
import { isInvalidTextRepresentation } from "../db/errors";
import { errorResponse } from "../http/errors";

import { MarkReadInput, MAX_CURSOR } from "@thinkersjournal/shared";

import type { NotificationItem, NotificationsPage } from "@thinkersjournal/shared";

const PAGE_SIZE = 30;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

interface DbRow {
  id: string;
  kind: NotificationItem["kind"];
  username: string;
  displayName: string | null;
  postId: string | null;
  postTitle: string | null;
  postSlug: string | null;
  commentId: string | null;
  reactionKind: string | null;
  createdAt: string;
  read: boolean;
}

export async function handleListNotifications(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () => errorResponse("LOGIN_REQUIRED", 401));
  if (session instanceof Response) return session;
  const cursor = new URL(request.url).searchParams.get("cursor") ?? MAX_CURSOR;

  try {
    const page = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<DbRow>(
        `SELECT n.id, n.kind,
                ap.username, ap.display_name AS "displayName",
                n.post_id AS "postId", p.title AS "postTitle", p.slug AS "postSlug",
                n.comment_id AS "commentId", n.reaction_kind AS "reactionKind",
                n.created_at AS "createdAt", (n.read_at IS NOT NULL) AS read
           FROM notifications n
           JOIN profiles ap ON ap.user_id = n.actor_id
           LEFT JOIN posts p ON p.id = n.post_id
          WHERE n.recipient_id = $1 AND n.id < $2
          ORDER BY n.id DESC
          LIMIT ${PAGE_SIZE + 1}`,
        [session.userId, cursor],
      );
      const hasMore = rows.length > PAGE_SIZE;
      const slice = rows.slice(0, PAGE_SIZE);
      const notifications: NotificationItem[] = slice.map((r) => ({
        id: r.id,
        kind: r.kind,
        actor: { username: r.username, displayName: r.displayName },
        postId: r.postId,
        postTitle: r.postTitle,
        postSlug: r.postSlug,
        commentId: r.commentId,
        reactionKind: r.reactionKind,
        createdAt: r.createdAt,
        read: r.read,
      }));
      return {
        notifications,
        nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
      } satisfies NotificationsPage;
    });
    return json(page);
  } catch (err) {
    // Malformed cursor → 22P02 on the uuid cast; convert to 400 like every other
    // keyset endpoint (feed.ts / public.ts / social-public.ts) per the M2.1
    // keyset convention. The IDOR scoping and no-store contract are unaffected.
    if (isInvalidTextRepresentation(err)) {
      return errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] });
    }
    throw err;
  }
}

export async function handleUnreadCount(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () => errorResponse("LOGIN_REQUIRED", 401));
  if (session instanceof Response) return session;
  const count = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ n: string }>(
      "SELECT count(*) n FROM notifications WHERE recipient_id=$1 AND read_at IS NULL",
      [session.userId],
    );
    return Number(rows[0]!.n);
  });
  return json({ count });
}

export async function handleMarkRead(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // No requireVerifiedEmail — an unverified user must still be able to clear
  // their own bell (deviation 1; precedent: logout). Still full origin+CSRF+epoch.
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: false });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = MarkReadInput.safeParse(body);
  if (!parsed.success) return errorResponse("INVALID_INPUT", 400, { fields: ["ids", "all"] });

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    parsed.data.all === true
      ? c.query("UPDATE notifications SET read_at=now() WHERE recipient_id=$1 AND read_at IS NULL", [userId])
      : c.query(
          "UPDATE notifications SET read_at=now() WHERE recipient_id=$1 AND read_at IS NULL AND id = ANY($2::uuid[])",
          [userId, parsed.data.ids],
        ),
  );
  return json({});
}
