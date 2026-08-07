/**
 * THE HOME FEED — pull-on-read, reverse-chronological, keyset-paginated. Per
 * viewer, so ALWAYS no-store and NEVER edge-cacheable (Cookie is not in the
 * cache key; a cached feed would be one viewer's graph served to everyone).
 * uuidv7 post ids are time-ordered, so ORDER BY id DESC is newest-first with no
 * created_at index — served by posts_author_published_key.
 */
import { MAX_CURSOR } from "@thinkersjournal/shared";

import { readCurrentSession } from "../auth/pipeline";
import { withClient } from "../db/client";
import { isInvalidTextRepresentation } from "../db/errors";
import { errorResponse } from "../http/errors";
import { getFolloweeIds } from "../social/followees";
import { TAGS_AGG } from "./public";

import type { Feed, FeedPost } from "@thinkersjournal/shared";

const PAGE_SIZE = 20;
const EXCERPT_SOURCE_CHARS = 400;

function feedJson(body: Feed): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    // Per-viewer: never stored anywhere shared.
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleFeed(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () =>
    errorResponse("LOGIN_REQUIRED", 401),
  );
  if (session instanceof Response) return session;

  const cursor = new URL(request.url).searchParams.get("cursor") ?? MAX_CURSOR;

  try {
    const feed = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const followeeIds = await getFolloweeIds(c, session.userId);
      if (followeeIds.length === 0) {
        return { posts: [], nextCursor: null } satisfies Feed;
      }

      const { rows } = await c.query<FeedPost>(
        `SELECT p.id, p.title, p.slug,
                left(p.markdown_source, ${EXCERPT_SOURCE_CHARS}) AS "excerptSource",
                p.published_at AS "publishedAt", p.updated_at AS "updatedAt",
                pr.username, pr.display_name AS "displayName", ${TAGS_AGG}
           FROM posts p
           JOIN profiles pr ON pr.user_id = p.author_id
          WHERE p.author_id = ANY($1::uuid[])
            AND p.status = 'published'
            AND p.id < $2
          ORDER BY p.id DESC
          LIMIT ${PAGE_SIZE + 1}`,
        [followeeIds, cursor],
      );

      const hasMore = rows.length > PAGE_SIZE;
      const page = rows.slice(0, PAGE_SIZE);
      return {
        posts: page,
        nextCursor: hasMore ? page[page.length - 1]!.id : null,
      } satisfies Feed;
    });
    return feedJson(feed);
  } catch (err) {
    if (isInvalidTextRepresentation(err)) {
      return errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] });
    }
    throw err;
  }
}
