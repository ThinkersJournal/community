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
 * ⚠️ EXACTLY ONE ROUTE HERE USES `HYPERDRIVE_CACHED` — `handlePublicRecent` —
 * and it is the ONLY route in this entire api that may
 * (apps/api/test/hyperdrive-binding-inventory.node.test.ts enforces this
 * mechanically, not just by convention: it fails if a second call site appears
 * anywhere under src/, or if this one moves). Every OTHER route in this file
 * uses `HYPERDRIVE_FRESH`.
 *
 * The reasoning, because it is a CORRECTNESS rule and not a performance
 * preference:
 *   • /public/posts and /public/profile back PURGE-TAGGED edge entries. The first
 *     render after a purge IS a read-after-write, and Hyperdrive never
 *     invalidates on write — so a CACHED read there can serve a PRE-EDIT row
 *     which the edge then re-caches for up to 25h. A 60s query cache turning
 *     into a 25h stale page is the whole hazard. FRESH here, unconditionally.
 *   • Behind a 3600s edge TTL a 60s Hyperdrive cache would hit ~never anyway: by
 *     the time the edge asks again, the 60s window is long gone. It would buy
 *     nothing to offset that hazard even if it were otherwise safe.
 *   • /public/recent is DIFFERENT IN KIND, not just "defensible in isolation":
 *     it is UNTAGGED — nothing purges it, ever — and its only two callers are
 *     `sitemap.xml`/`rss.xml` (Task 18), whose edge entries carry a 60s
 *     `maxAge`/600s `swr` (apps/web/src/lib/cache.ts's `markFeedCacheable`).
 *     Untagged means the first render after an edit is NOT a read-after-write —
 *     there is no purge to race — so Hyperdrive's 60s cache window is a strict
 *     SUBSET of the 60s edge staleness that TTL already accepts. Task 9 kept
 *     this route on FRESH regardless, because at that point the compensating
 *     edge TTL had not been built yet (T12/T13 built it): a CACHED read with no
 *     cache in front of it would just have been a stale read bought for
 *     nothing. That gap is closed now, so the deferred call is made HERE:
 *     `handlePublicRecent` reads through `HYPERDRIVE_CACHED`.
 *   • ⚠️ THIS DOES NOT GENERALIZE TO A FUTURE CALLER. If `/public/recent` ever
 *     grows a caller whose edge entry IS purge-tagged (a cacheable homepage
 *     feed, say), it must either read through a SEPARATE route that stays
 *     FRESH, or this route goes back to FRESH — the exact hazard the first
 *     bullet describes, reopened. Nothing enforces that automatically; it is a
 *     fact about today's only two callers, not a property of this route's name.
 */
import { MAX_CURSOR } from "@thinkersjournal/shared";

import { withClient } from "../db/client";
import { isInvalidTextRepresentation } from "../db/errors";
import { errorResponse } from "../http/errors";

import type {
  DiscoverPage,
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

// Like `json()` but `cache-control: no-store`. Used ONLY by /public/discover,
// which backs a purge-tagged LONG-TTL edge page (the `/` Discover feed); the M2.4b
// spec pins its FRESH api response as no-store (defense-in-depth — the api is
// binding-only, so there is no intermediary cache today). Kept separate so the
// other reads in this file (recent/profile/post) keep their existing headers.
function jsonNoStore(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
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
          -- ⚠️ PAGE_SIZE + 1, not PAGE_SIZE. The one extra row is a SENTINEL whose
          -- mere existence answers "is there a next page?". With a flat LIMIT
          -- PAGE_SIZE, a page of exactly PAGE_SIZE rows returns a non-null cursor
          -- onto an EMPTY next page (one wasted round trip) — which the DTO's
          -- "null when there are no more" (packages/shared/src/posts.ts) forbids.
          LIMIT ${PAGE_SIZE + 1}`,
        [owner[0].userId, cursor],
      );

      const rows = posts as PublicPostSummary[];
      // The sentinel (if it came back) is proof of a next page: drop it from the
      // page returned, and hand its predecessor's id back as the cursor.
      const hasMore = rows.length > PAGE_SIZE;
      const page = rows.slice(0, PAGE_SIZE);
      return {
        ...owner[0],
        posts: page,
        // Non-null ONLY when a real next row exists — never a cursor onto emptiness.
        nextCursor: hasMore ? page[page.length - 1]!.id : null,
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

  // ⚠️ HYPERDRIVE_CACHED — see the file header. The ONLY read in this api that
  // may use it: this route is UNTAGGED (nothing purges it, ever) and its only
  // callers (sitemap.xml, rss.xml) sit behind a 60s edge TTL that already
  // accepts this staleness, so Hyperdrive's 60s cache window adds nothing new.
  // test/hyperdrive-binding-inventory.node.test.ts enforces that this stays the
  // sole call site.
  const posts = await withClient(env.HYPERDRIVE_CACHED, ctx, async (c) => {
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

export async function handlePublicDiscover(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // First page uses the all-f sentinel so ONE query serves page 1 and page N.
  const cursor = new URL(request.url).searchParams.get("cursor") ?? MAX_CURSOR;
  try {
    // ⚠️ HYPERDRIVE_FRESH, never CACHED: this route backs a PURGE-TAGGED edge entry
    // (the `/` Discover page subscribes to `listing`), so the first render after a
    // publish/edit is a read-after-write. A cached read there could re-cache a
    // pre-edit row for up to 25h. See this file's header, bullet 4.
    const page = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query(
        `SELECT p.id, p.title, p.slug, pr.username,
                left(p.markdown_source, ${EXCERPT_SOURCE_CHARS}) AS "excerptSource",
                p.published_at AS "publishedAt", p.updated_at AS "updatedAt"
           FROM posts p
           JOIN profiles pr ON pr.user_id = p.author_id
          WHERE p.status = 'published' AND p.id < $1
          ORDER BY p.id DESC
          LIMIT ${PAGE_SIZE + 1}`,
        [cursor],
      );
      const list = rows as RecentPost[];
      const hasMore = list.length > PAGE_SIZE;
      const posts = list.slice(0, PAGE_SIZE);
      return {
        posts,
        nextCursor: hasMore ? posts[posts.length - 1]!.id : null,
      } satisfies DiscoverPage;
    });
    return jsonNoStore(page);
  } catch (err) {
    // `id < 'not-a-uuid'` throws 22P02 — the client's error, not a 500.
    if (isInvalidTextRepresentation(err)) {
      return errorResponse("INVALID_INPUT", 400, { fields: ["cursor"] });
    }
    throw err;
  }
}
