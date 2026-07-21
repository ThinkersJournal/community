/**
 * ANONYMOUS social reads. Like src/routes/public.ts these read NO session and
 * are viewer-independent — BUT unlike the post/profile reads they are NOT
 * edge-cached: they change on every follow and are fetched live by the profile
 * page's client-side social island (web marks them no-store). So they use
 * HYPERDRIVE_FRESH (never CACHED) and carry no cache-tag.
 */
import { MAX_CURSOR } from "@thinkersjournal/shared";

import { withClient } from "../db/client";
import { isInvalidTextRepresentation } from "../db/errors";
import { errorResponse } from "../http/errors";

import type { AuthorSummary, AuthorsPage, FollowList, FollowUser, SocialCounts } from "@thinkersjournal/shared";

const PAGE_SIZE = 30;
const AUTHORS_PAGE_SIZE = 24;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function notFound(): Response {
  return errorResponse("NOT_FOUND", 404);
}

/** Resolve a handle to its user id, or null. */
async function userIdForUsername(
  env: Env,
  ctx: ExecutionContext,
  username: string,
): Promise<string | null> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ user_id: string }>(
      "SELECT user_id FROM profiles WHERE username = $1",
      [username],
    );
    return rows[0]?.user_id ?? null;
  });
}

export async function handlePublicSocial(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const username = new URL(request.url).searchParams.get("username");
  if (username === null) return notFound();
  const userId = await userIdForUsername(env, ctx, username);
  if (userId === null) return notFound();

  const counts = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ followers: string; following: string }>(
      `SELECT
         (SELECT count(*) FROM follows WHERE followee_id = $1) AS followers,
         (SELECT count(*) FROM follows WHERE follower_id = $1) AS following`,
      [userId],
    );
    // count(*) comes back as a bigint string — coerce to number.
    return {
      followersCount: Number(rows[0]!.followers),
      followingCount: Number(rows[0]!.following),
    } satisfies SocialCounts;
  });
  return json(counts);
}

/** Shared keyset list body for followers/following, parameterized by which column anchors the list. */
async function listUsers(
  env: Env,
  ctx: ExecutionContext,
  anchorColumn: "followee_id" | "follower_id",
  joinColumn: "follower_id" | "followee_id",
  username: string,
  cursorParam: string | null,
): Promise<Response> {
  const userId = await userIdForUsername(env, ctx, username);
  if (userId === null) return notFound();
  const cursor = cursorParam ?? MAX_CURSOR;

  try {
    const list = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<FollowUser & { cursorId: string }>(
        `SELECT pr.username, pr.display_name AS "displayName", f.id AS "cursorId"
           FROM follows f
           JOIN profiles pr ON pr.user_id = f.${joinColumn}
          WHERE f.${anchorColumn} = $1 AND f.id < $2
          ORDER BY f.id DESC
          LIMIT ${PAGE_SIZE + 1}`,
        [userId, cursor],
      );
      const hasMore = rows.length > PAGE_SIZE;
      const page = rows.slice(0, PAGE_SIZE);
      return {
        users: page.map(({ username: u, displayName }) => ({ username: u, displayName })),
        nextCursor: hasMore ? page[page.length - 1]!.cursorId : null,
      } satisfies FollowList;
    });
    return json(list);
  } catch (err) {
    if (isInvalidTextRepresentation(err)) {
      return errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] });
    }
    throw err;
  }
}

/** Who follows X: anchor on followee_id, join the follower to get their profile. */
export function handlePublicFollowers(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const username = url.searchParams.get("username");
  if (username === null) return Promise.resolve(notFound());
  return listUsers(env, ctx, "followee_id", "follower_id", username, url.searchParams.get("cursor"));
}

/** Who X follows: anchor on follower_id, join the followee to get their profile. */
export function handlePublicFollowing(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const username = url.searchParams.get("username");
  if (username === null) return Promise.resolve(notFound());
  return listUsers(env, ctx, "follower_id", "followee_id", username, url.searchParams.get("cursor"));
}

/**
 * Recently-active published authors, keyset by each author's LATEST published
 * post id (uuidv7 → time-ordered). An author with only drafts never appears
 * (the inner filter is status='published'). FRESH binding — the edge TTL on the
 * web /authors page is the only cache (see this route's task note).
 *
 * ⚠️ DEVIATION FROM THE TASK BRIEF'S SQL: the brief's inner subquery was
 * `SELECT author_id, max(id) ... GROUP BY author_id`, but Postgres has no
 * built-in `max(uuid)` aggregate (verified against the live PG18 instance:
 * `function max(uuid) does not exist` — uuid has a btree opclass for `<`/`>`/
 * `ORDER BY`, which is what min/max would need, but no min/max aggregate is
 * registered for it). `DISTINCT ON (author_id) ... ORDER BY author_id, id DESC`
 * picks the same "one row per author, latest published post" set using only
 * the sort operators uuid does support, and the planner uses the existing
 * `posts_author_published_key` index for it (EXPLAIN verified).
 */
export async function handlePublicAuthors(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const cursor = new URL(request.url).searchParams.get("cursor") ?? MAX_CURSOR;

  try {
    const pageData = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<AuthorSummary>(
        `SELECT pr.user_id AS "userId", pr.username, pr.display_name AS "displayName",
                latest.latest_post_id AS "latestPostId"
           FROM (
             SELECT DISTINCT ON (author_id) author_id, id AS latest_post_id
               FROM posts
              WHERE status = 'published'
              ORDER BY author_id, id DESC
           ) latest
           JOIN profiles pr ON pr.user_id = latest.author_id
          WHERE latest.latest_post_id < $1
          ORDER BY latest.latest_post_id DESC
          LIMIT ${AUTHORS_PAGE_SIZE + 1}`,
        [cursor],
      );
      const hasMore = rows.length > AUTHORS_PAGE_SIZE;
      const authors = rows.slice(0, AUTHORS_PAGE_SIZE);
      return {
        authors,
        nextCursor: hasMore ? authors[authors.length - 1]!.latestPostId : null,
      } satisfies AuthorsPage;
    });
    return json(pageData);
  } catch (err) {
    if (isInvalidTextRepresentation(err)) {
      return errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] });
    }
    throw err;
  }
}
