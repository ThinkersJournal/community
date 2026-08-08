/**
 * Post authoring routes. The M0 stub is gone; the auth around it is unchanged.
 *
 *   POST  /posts      — create (draft or published)
 *   PATCH /posts/:id  — edit
 *   GET   /posts/:id  — the AUTHOR's own post, drafts included
 *
 * All three are AUTHOR-facing. Anonymous reads live in src/routes/public.ts.
 *
 * ⚠️ EVERY DB ACCESS HERE USES HYPERDRIVE_FRESH — including the reads. These are
 * permission decisions and read-after-write against the author's own writes, and
 * Hyperdrive never invalidates on write. A CACHED read here would let an author
 * save an edit and be shown their own pre-edit text for up to 60s.
 *
 * ⚠️ OWNERSHIP IS ENFORCED IN THE `WHERE` CLAUSE, never by a preceding SELECT.
 * The transaction-mode pooler means a check-then-act is a race by construction;
 * `WHERE id = $1 AND author_id = $2` returning zero rows is the check, atomically.
 * Zero rows is a 404 — NEVER a 403, which would confirm the id names a real post.
 *
 * ⚠️ PURGE-ON-EDIT IS PART OF THE WRITE, not an afterthought. The tags here are
 * exactly the ones apps/web/src/lib/cache.ts sets on the public renders; a write
 * that skips the purge leaves that content stale for a full maxAge+swr window
 * (25 HOURS). test/purge-wiring.test.ts pins every call site.
 *
 * ⚠️ NO RATE LIMITER ON `POST /posts` — DELIBERATE, not forgotten. The mutating
 * pipeline gates creation on origin -> session -> CSRF -> epoch -> verified-email,
 * but it opts OUT of the (opt-in) rate limiter: there is no posts-limiter binding,
 * and per-author content-creation throttling is deferred to the per-author
 * rate-budget DO (M3 in the plan's Deferred record —
 * docs/superpowers/plans/2026-07-15-m1-publishing-and-public-web.md). Until then
 * M1 leans on the deploy gate's Cloudflare WAF rule. Recorded here so the
 * omission reads as a decision, like every other omission in this file.
 */
import { CreatePostInput, UpdatePostInput } from "@thinkersjournal/shared";

import { readCurrentSession, runMutatingPipeline } from "../auth/pipeline";
import { purgeTags } from "../cache/purge";
import { withClient } from "../db/client";
import { isInvalidTextRepresentation, isUniqueViolation } from "../db/errors";
import { errorResponse } from "../http/errors";
import { randomSuffix } from "../util/random";

import type { RouteParams } from "../routing";
import type { AuthoredPost } from "@thinkersjournal/shared";
import type { Client } from "pg";

/** Attempts to place a unique slug before giving up. */
const SLUG_ATTEMPTS = 3;
const SLUG_BASE_MAX = 60;

/**
 * A URL-safe slug from a title.
 *
 * NFKD + combining-mark strip folds accents rather than dropping them ("Café" ->
 * "cafe", not "caf"). Everything outside [a-z0-9] collapses to a single hyphen.
 * A title that is entirely non-Latin sanitizes to "" and falls back to "post",
 * whose uniqueness then comes entirely from the suffix retry below.
 *
 * The trailing-hyphen strip is repeated AFTER the truncation deliberately: the
 * slice can land mid-separator and leave "my-long-title-" behind.
 */
/**
 * slugify's sanitize, WITHOUT the ""->"post" fallback. Shared by `slugify` (which
 * adds the fallback) and `slugifyTag` (which returns null instead) so the two can
 * never drift apart on accent-folding or the [a-z0-9] rule. EXPORTED because the
 * read path canonicalizes the same way: handlePublicTag (public.ts) runs the
 * requested `?slug=` through THIS function, so the slug it caches under is always
 * one the `tag:<slug>` purge here can emit. Read and write canonicalization are
 * the one function — they cannot drift into an unpurgeable cache tag.
 */
export function slugifyBase(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    // U+0300\u2013U+036F is the Combining Diacritical Marks block: NFKD splits an
    // accented letter into base + mark, and this drops the mark ("caf\u00e9" -> "cafe").
    // \u26a0\ufe0f ESCAPES, NOT the literal marks \u2014 a raw range here is invisible in review
    // and one editor re-normalization from silently degrading accent-folding.
    // test/posts.test.ts pins "Caf\u00e9" -> "cafe".
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_BASE_MAX)
    .replace(/-+$/, "");
}

export function slugify(title: string): string {
  const base = slugifyBase(title);
  return base === "" ? "post" : base;
}

/** A tag slug, or null when the label has no usable [a-z0-9] content (no "post" fallback). */
function slugifyTag(label: string): string | null {
  const base = slugifyBase(label);
  return base === "" ? null : base;
}

/** The most tags a single post may carry (also enforced by the Zod schema's `.max(5)`). */
const MAX_TAGS = 5;

/**
 * Normalize author labels -> unique, non-empty slugs (<=MAX_TAGS), keeping the
 * FIRST label seen per slug. A label that slugifies to nothing (all non-Latin /
 * punctuation) is dropped \u2014 `slugifyTag` returns null there rather than the
 * `"post"` fallback `slugify` would produce, so an untypable tag never becomes a
 * spurious "post" tag.
 */
function normalizeTags(labels: string[]): { slug: string; label: string }[] {
  const out: { slug: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const slug = slugifyTag(label);
    if (slug === null || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, label: label.trim() });
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

/** Read a post's current tag slugs \u2014 the OLD half of the edit purge's old \u222a new. */
async function readTagSlugs(client: Client, postId: string): Promise<string[]> {
  const { rows } = await client.query<{ slug: string }>(
    `SELECT t.slug FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = $1`,
    [postId],
  );
  return rows.map((r) => String(r.slug));
}

/**
 * Upsert the tags and rewrite the post's join rows on the SAME held connection.
 * Returns the post's new slugs (for the purge).
 *
 * \u26a0\ufe0f citext CASTS ARE REQUIRED, not decorative. `tags.slug` is citext, and pg's
 * extended protocol will not implicitly coerce a text[] parameter to citext[] \u2014
 * `unnest($1::citext[], ...)` and `slug = ANY($2::citext[])` make the type match
 * the column so the INSERT-select and the join lookup both bind.
 *
 * DELETE-then-reinsert (not a diff): a handful of rows, and it makes "the join
 * rows are exactly `slugs`" true by construction \u2014 no stale row can survive.
 */
async function writeTags(client: Client, postId: string, labels: string[]): Promise<string[]> {
  const tags = normalizeTags(labels);
  const slugs = tags.map((t) => t.slug);
  await client.query(`DELETE FROM post_tags WHERE post_id = $1`, [postId]);
  if (slugs.length === 0) return [];
  await client.query(
    `INSERT INTO tags (slug, label)
     SELECT s, l FROM unnest($1::citext[], $2::text[]) AS x(s, l)
     ON CONFLICT (slug) DO NOTHING`,
    [slugs, tags.map((t) => t.label)],
  );
  await client.query(
    `INSERT INTO post_tags (post_id, tag_id)
     SELECT $1, id FROM tags WHERE slug = ANY($2::citext[])`,
    [postId, slugs],
  );
  return slugs;
}

/**
 * The 401 for a session-bearing GET with no usable session.
 *
 * `Record<string, string>` rather than `HeadersInit`: this is SPREAD by
 * `errorResponse`, and spreading a `Headers` instance silently yields `{}` —
 * dropping the revocation path's cleared cookie. See src/auth/pipeline.ts's
 * `unauthorized` for the full reasoning.
 */
function loginRequired(extraHeaders: Record<string, string> = {}): Response {
  return errorResponse("LOGIN_REQUIRED", 401, { headers: extraHeaders });
}

/** The one 404 for "no such post, or not yours" — deliberately not two answers. */
function notFound(): Response {
  return errorResponse("NOT_FOUND", 404);
}

interface InsertedPost {
  id: string;
  slug: string;
  username: string;
  /** The normalized tag slugs written for this post — the create purge's tag pages. */
  newSlugs: string[];
}

/**
 * The author's `profiles.username`, for the create/edit response.
 *
 * ⚠️ WHY THIS EXISTS AT ALL — T17's editor redirects a successful PUBLISH to
 * `/@<username>/<slug>`, and that Worker has no session of its own (it forwards
 * the browser's cookie to US, not the other way around) — it cannot compute a
 * username it was never told. Rather than have the editor page make a SECOND
 * round trip (or, worse, thread a username through `GET /auth/csrf`, which
 * would conflate an unrelated concern), the create/update handlers that already
 * know `authorId` hand it back alongside `id`/`slug`.
 *
 * A separate SELECT, not a JOIN on the INSERT/UPDATE: `profiles.user_id` is a
 * FOREIGN KEY into `users`, and `authorId` is the SESSION's user (never the
 * body — see handleCreatePost), so the row is guaranteed to exist. A JOIN would
 * work too, but two simple statements over one held connection cost the same
 * round trips either way and read far more plainly.
 */
async function usernameFor(client: Client, authorId: string): Promise<string> {
  const { rows } = await client.query<{ username: string }>(
    "SELECT username FROM profiles WHERE user_id = $1",
    [authorId],
  );
  return rows[0]!.username;
}

/**
 * INSERT the post, retrying with a suffixed slug on a `posts_author_slug_key`
 * violation.
 *
 * No SAVEPOINT (unlike signup's profile insert): this is a SINGLE statement with
 * no enclosing transaction, so a failure poisons nothing and the retry is just a
 * retry. Only a unique violation is retried; anything else propagates.
 *
 * ⚠️ INSERT-AND-HANDLE-23505, never SELECT-then-INSERT. Under a transaction-mode
 * pooler a "is this slug free?" check is a race by construction: two concurrent
 * creates both read "free" and one of them 500s. The unique index is the check.
 */
async function insertPost(
  client: Client,
  authorId: string,
  title: string,
  markdownSource: string,
  status: string,
  tags: string[],
): Promise<InsertedPost> {
  const base = slugify(title);
  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 1 ? base : `${base}-${randomSuffix()}`;
    try {
      const { rows } = await client.query<{ id: string; slug: string }>(
        `INSERT INTO posts (author_id, title, slug, markdown_source, status, published_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'published' THEN now() ELSE NULL END)
         RETURNING id, slug`,
        [authorId, title, slug, markdownSource, status],
      );
      const { id, slug: insertedSlug } = rows[0]!;
      // ⚠️ AFTER the RETURNING succeeds, so a tag write can NEVER re-enter the
      // slug-retry loop: only `posts_author_slug_key` (23505) is retried, and
      // writeTags cannot raise it (tags upsert is ON CONFLICT DO NOTHING; the
      // join rows are deduped after a DELETE, so no PK collision either).
      const newSlugs = await writeTags(client, id, tags);
      return { id, slug: insertedSlug, username: await usernameFor(client, authorId), newSlugs };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === SLUG_ATTEMPTS) throw err;
    }
  }
  // Unreachable: the FINAL iteration (attempt === SLUG_ATTEMPTS) rethrows on a
  // 23505 and every non-23505 rethrows immediately, so the loop always exits via
  // `return` or `throw`. This satisfies the compiler's control-flow analysis,
  // which cannot prove a runtime-bounded loop terminates — it is NOT a real
  // "gave up" path (each retry adds ~64 bits of entropy). The 409 for a genuine
  // exhaustion comes from handleCreatePost's catch on the rethrown 23505, not here.
  throw new Error("unreachable: insertPost exhausted its slug-retry loop");
}

/** The onboarding gate: a public post needs a durable @handle. Drafts are exempt. */
async function requireChosenUsername(
  env: Env,
  ctx: ExecutionContext,
  userId: string,
): Promise<Response | null> {
  const chosen = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ username_chosen: boolean }>(
      "SELECT username_chosen FROM profiles WHERE user_id = $1",
      [userId],
    );
    return rows[0]?.username_chosen === true;
  });
  return chosen ? null : errorResponse("USERNAME_REQUIRED", 409);
}

/** Parse + validate a post body. Resolves the fields, or the 400 to return. */
async function readPostInput(
  request: Request,
  schema: typeof CreatePostInput | typeof UpdatePostInput,
): Promise<{ title: string; markdownSource: string; status: string; tags: string[] } | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // A malformed body is the client's error, not a 500.
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // FIELD NAMES only — never the submitted values.
    return errorResponse("INVALID_INPUT", 400, {
      fields: parsed.error.issues.map((i) => i.path.map(String).join(".")),
    });
  }
  return parsed.data;
}

export async function handleCreatePost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;

  const input = await readPostInput(request, CreatePostInput);
  if (input instanceof Response) return input;
  const { title, markdownSource, status } = input;

  // ⚠️ author_id comes from the PIPELINE's validated session, NEVER the body —
  // which a caller controls. `CreatePostInput` has no authorId field at all, so
  // this is unrepresentable rather than merely unused.
  const authorId = result.session.userId;

  // ⚠️ A published post appears under the author's @handle immediately (decision
  // #7), so a public post requires one to already exist. Drafts are exempt —
  // gate on the RESULTING status, before the write, never after.
  if (status === "published") {
    const gate = await requireChosenUsername(env, ctx, authorId);
    if (gate !== null) return gate;
  }

  let inserted: InsertedPost;
  try {
    inserted = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      insertPost(c, authorId, title, markdownSource, status, input.tags),
    );
  } catch (err) {
    // Every retry collided: answer 409 rather than 500. Astronomically unlikely
    // (each retry adds ~64 bits of entropy), but a 23505 must never be a crash.
    // ⚠️ THIS catch is the ONLY path to the 409 — insertPost returns an
    // InsertedPost or throws, never null, so there is no null branch to check.
    if (isUniqueViolation(err)) return errorResponse("SLUG_TAKEN", 409);
    throw err;
  }

  // Publishing changes what a LISTING shows. There is no `post:` tag to purge —
  // nothing has ever been cached for a post that did not exist until now. Each
  // new tag PAGE now shows one more post, so its `tag:<slug>` joins the purge. A
  // draft purges NOTHING: it is in no cached listing, and purge quota is scarce.
  if (status === "published") {
    await purgeTags(env, [
      `author:${authorId}`,
      "listing",
      ...inserted.newSlugs.map((s) => `tag:${s}`),
    ]);
  }

  return new Response(
    JSON.stringify({ id: inserted.id, slug: inserted.slug, status, username: inserted.username }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}

export async function handleUpdatePost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;

  const input = await readPostInput(request, UpdatePostInput);
  if (input instanceof Response) return input;
  const { title, markdownSource, status } = input;
  const authorId = result.session.userId;

  // ⚠️ Gate on the RESULTING (incoming) status, before the write — a draft->
  // published transition and a published-and-still-published edit both count;
  // draft->draft never does. This runs BEFORE the ownership check embedded in
  // the UPDATE's WHERE clause below, so it answers from the SESSION's own
  // username_chosen — never a proxy for whether the post exists or is theirs.
  if (status === "published") {
    const gate = await requireChosenUsername(env, ctx, authorId);
    if (gate !== null) return gate;
  }

  let updated: {
    id: string;
    slug: string;
    username: string;
    oldSlugs: string[];
    newSlugs: string[];
  } | null;
  try {
    updated = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query<{ id: string; slug: string }>(
        `UPDATE posts
            SET title = $1,
                markdown_source = $2,
                status = $3,
                -- FIRST publication only: coalesce keeps the original date across
                -- every later edit, so re-publishing does not rewrite history (or
                -- re-order the author's own listing under them).
                published_at = CASE WHEN $3 = 'published' THEN coalesce(published_at, now()) ELSE published_at END,
                updated_at = now()
          -- ⚠️ OWNERSHIP IS THIS LINE. Not a preceding SELECT: under a
          -- transaction-mode pooler a check-then-act is a race by construction.
          WHERE id = $4 AND author_id = $5
      RETURNING id, slug`,
        [title, markdownSource, status, params.id, authorId],
      );
      const row = rows[0];
      // ⚠️ Only fetched on a HIT. A miss (wrong id, or not this author's) must
      // stay a single query — see the purge-quota reasoning below: the same
      // "don't spend anything extra on a request that turns out to be a 404"
      // discipline applies to this SELECT as much as to the purge call.
      if (row === undefined) return null;
      // ⚠️ READ THE OLD SLUGS BEFORE writeTags — it DELETEs the join rows. The
      // edit purge must cover a REMOVED tag's page (old ∪ new), so a tag dropped
      // by this edit still gets its now-shorter page invalidated.
      const oldSlugs = await readTagSlugs(c, row.id);
      const newSlugs = await writeTags(c, row.id, input.tags);
      return { id: row.id, slug: row.slug, username: await usernameFor(c, authorId), oldSlugs, newSlugs };
    });
  } catch (err) {
    // A malformed id is a 404, not a 500: `WHERE id = 'not-a-uuid'` throws
    // (22P02) before it can match nothing. `:id` reaches here as any non-empty
    // single segment — src/routing.ts guarantees nothing about its SHAPE.
    if (isInvalidTextRepresentation(err)) return notFound();
    throw err;
  }
  // ⚠️ Zero rows means "no such post" OR "not yours" — answered identically.
  if (updated === null) return notFound();

  // ⚠️ BELOW THE 404 ABOVE, AND THAT ORDER IS A SECURITY PROPERTY, not tidiness.
  // Purge quota is 5 requests/MINUTE for the whole zone. Purging before the
  // ownership check would let anyone burn it by PATCHing ids they do not own —
  // a cheap, unauthenticated-in-effect denial of invalidation, whose symptom is
  // everyone ELSE's edits going stale for 25h. test/purge-wiring.test.ts pins
  // this with "a 404 edit purges NOTHING"; moving this line above the check
  // reddens it.
  // ⚠️ ONE call, ALL tags. A call per tag would spend an author's whole budget in
  // under two edits.
  // ⚠️ AWAITED, not fired into ctx.waitUntil(): the editor redirects to the post
  // page straight after this, and purging behind the response races that
  // redirect — showing the author their own stale post. Purge is ~10-50ms and
  // edits are rare. It NEVER throws (see src/cache/purge.ts): the post is already
  // committed, so a failed invalidation must not lose the user's work.
  //
  // ⚠️ OLD ∪ NEW tag pages: a tag REMOVED by this edit still owns a cached page
  // that now lists one fewer post, so it must be invalidated alongside the added
  // ones. Deduped + SORTED so the purge payload is deterministic (and a tag both
  // kept and re-sent appears once).
  const tagTags = [...new Set([...updated.oldSlugs, ...updated.newSlugs])]
    .sort()
    .map((s) => `tag:${s}`);
  await purgeTags(env, [`post:${updated.id}`, `author:${authorId}`, "listing", ...tagTags]);

  return new Response(
    JSON.stringify({ id: updated.id, slug: updated.slug, status, username: updated.username }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export async function handleGetPost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: RouteParams,
): Promise<Response> {
  const session = await readCurrentSession(env, request, loginRequired);
  if (session instanceof Response) return session;

  let post: AuthoredPost | null;
  try {
    post = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      const { rows } = await c.query(
        `SELECT p.id, p.title, p.slug, p.markdown_source AS "markdownSource", p.status,
                p.published_at AS "publishedAt", p.updated_at AS "updatedAt",
                COALESCE((SELECT json_agg(json_build_object('slug', t.slug, 'label', t.label) ORDER BY t.slug)
                            FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id),
                         '[]'::json) AS tags
           FROM posts p WHERE p.id = $1 AND p.author_id = $2`,
        [params.id, session.userId],
      );
      return (rows[0] ?? null) as AuthoredPost | null;
    });
  } catch (err) {
    if (isInvalidTextRepresentation(err)) return notFound();
    throw err;
  }
  if (post === null) return notFound();

  return new Response(JSON.stringify(post), {
    status: 200,
    // Per-author and includes unpublished text: never let a shared cache hold it.
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
