/**
 * ANONYMOUS public reads — the only api routes the `web` Worker calls WITHOUT
 * forwarding the browser's cookie, and the ones whose output the edge caches.
 *
 * ⚠️ THESE MUST BE VIEWER-INDEPENDENT BY CONSTRUCTION. Cookie is NOT in the
 * Workers Cache key and does NOT trigger bypass, so any per-viewer variance here
 * becomes content cached under one viewer's identity and served to everyone. No
 * route in this file reads a session, and test/public-reads.test.ts pins that a
 * draft 404s even for its OWN author.
 *
 * ⚠️ EVERY ROUTE HERE USES HYPERDRIVE_FRESH. `HYPERDRIVE_CACHED` is reserved for
 * the sitemap.xml/rss.xml renderers (Task 18) and is used nowhere in this file.
 *
 * The reasoning, because it is a CORRECTNESS rule and not a performance
 * preference:
 *   • /public/posts and /public/profile back PURGE-TAGGED edge entries. The first
 *     render after a purge IS a read-after-write, and Hyperdrive never
 *     invalidates on write — so a CACHED read there can serve a PRE-EDIT row
 *     which the edge then re-caches for up to 25h. A 60s query cache turning
 *     into a 25h stale page is the whole hazard.
 *   • Behind a 3600s edge TTL a 60s Hyperdrive cache hits ~never anyway: by the
 *     time the edge asks again, the 60s window is long gone. It buys nothing to
 *     offset that hazard.
 *   • /public/recent is TTL-only and untagged, so CACHED would be defensible for
 *     it in isolation — Task 9's brief specifies exactly that. It is FRESH here
 *     regardless, on instruction, and the tradeoff is worth stating plainly: the
 *     cost is one uncached query per 60s window per PoP, and the benefit is that
 *     this file has ONE rule ("FRESH here, always") rather than a per-route
 *     judgement call that the next author must re-derive correctly. Task 18 owns
 *     the sitemap/RSS renderers and can revisit the binding THERE, where the
 *     staleness budget actually lives, with the cache it is reasoning about in
 *     front of it.
 */
import { MAX_CURSOR } from "@thinkersjournal/shared";

import { withClient } from "../db/client";
import { isInvalidTextRepresentation } from "../db/errors";
import { errorResponse } from "../http/errors";

import type {
  PublicPost,
  PublicPostSummary,
  PublicProfile,
  RecentPost,
} from "@thinkersjournal/shared";

const PAGE_SIZE = 20;
/** Bounded because sitemap/RSS consume this; real pagination is M2. */
const RECENT_MAX = 1000;
/** Enough for an excerpt; bounds the listing payload. */
const EXCERPT_SOURCE_CHARS = 400;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function notFound(): Response {
  return errorResponse("NOT_FOUND", 404);
}

export async function handlePublicPost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const username = url.searchParams.get("username");
  const slug = url.searchParams.get("slug");
  if (username === null || slug === null) return notFound();

  const post = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      `SELECT p.id, p.author_id AS "authorId", pr.username, pr.display_name AS "displayName",
              p.title, p.slug, p.markdown_source AS "markdownSource",
              p.published_at AS "publishedAt", p.updated_at AS "updatedAt"
         FROM posts p
         JOIN profiles pr ON pr.user_id = p.author_id
        WHERE pr.username = $1 AND p.slug = $2 AND p.status = 'published'`,
      [username, slug],
    );
    return (rows[0] ?? null) as PublicPost | null;
  });
  // ⚠️ `status = 'published'` is IN the query, not a filter afterwards: a draft
  // must be indistinguishable from a nonexistent post to everyone, its author
  // included (see the file header).
  return post === null ? notFound() : json(post);
}

export async function handlePublicProfile(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const username = url.searchParams.get("username");
  if (username === null) return notFound();
  // The all-f sentinel: every uuid sorts below it, so ONE query serves page 1
  // and page N and the two cannot drift apart.
  const cursor = url.searchParams.get("cursor") ?? MAX_CURSOR;

  try {
    const profile = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows: owner } = await c.query<{
        userId: string;
        username: string;
        displayName: string | null;
        bio: string | null;
      }>(
        `SELECT user_id AS "userId", username, display_name AS "displayName", bio
           FROM profiles WHERE username = $1`,
        [username],
      );
      if (owner[0] === undefined) return null;

      const { rows: posts } = await c.query(
        `SELECT id, title, slug,
                left(markdown_source, ${EXCERPT_SOURCE_CHARS}) AS "excerptSource",
                published_at AS "publishedAt", updated_at AS "updatedAt"
           FROM posts
          WHERE author_id = $1 AND status = 'published' AND id < $2
          -- v7 ids are time-ordered, so this IS newest-first. No created_at
          -- index exists, and none is needed. Served by posts_author_published_key.
          ORDER BY id DESC
          LIMIT ${PAGE_SIZE}`,
        [owner[0].userId, cursor],
      );

      const page = posts as PublicPostSummary[];
      return {
        ...owner[0],
        posts: page,
        // null when this page was short — i.e. there is no next page to ask for.
        nextCursor: page.length === PAGE_SIZE ? page[page.length - 1]!.id : null,
      } satisfies PublicProfile;
    });
    return profile === null ? notFound() : json(profile);
  } catch (err) {
    // `id < 'not-a-uuid'` throws 22P02. A malformed cursor is the client's error.
    if (isInvalidTextRepresentation(err)) {
      return errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] });
    }
    throw err;
  }
}

/**
 * The `limit` query param: absent -> the max, a valid count -> clamped into
 * [1, RECENT_MAX], anything else -> the 400 to return.
 *
 * ⚠️ A NON-NUMERIC `limit` IS REJECTED, NOT CLAMPED — a deliberate departure
 * from the brief's `Number.isFinite(...) ? ... : RECENT_MAX` fallback. Answering
 * `?limit=abc` with 200 + 1000 posts silently invents an intent the caller never
 * expressed, and it is the difference between this route HAVING a client-error
 * path and claiming (in test/error-envelope.test.ts's ERROR_FREE ledger) to have
 * none while holding a DB query — a claim that ledger's own header calls wrong.
 * An out-of-RANGE number is still clamped: `?limit=5000` is a coherent ask with
 * an obvious bounded answer.
 */
function recentLimit(url: URL): number | Response {
  const raw = url.searchParams.get("limit");
  if (raw === null) return RECENT_MAX;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["limit"] });
  }
  return Math.min(Math.max(parsed, 1), RECENT_MAX);
}

export async function handlePublicRecent(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const limit = recentLimit(new URL(request.url));
  if (limit instanceof Response) return limit;

  const posts = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query(
      `SELECT p.id, p.title, p.slug, pr.username,
              left(p.markdown_source, ${EXCERPT_SOURCE_CHARS}) AS "excerptSource",
              p.published_at AS "publishedAt", p.updated_at AS "updatedAt"
         FROM posts p
         JOIN profiles pr ON pr.user_id = p.author_id
        WHERE p.status = 'published'
        ORDER BY p.id DESC
        LIMIT $1`,
      [limit],
    );
    return rows as RecentPost[];
  });
  return json({ posts });
}
