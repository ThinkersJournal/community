/**
 * THE POST WIRE TYPES — shared by the `api` Worker (which emits them) and the
 * `web` Worker (which renders them).
 *
 * ⚠️ THE DTOs BELOW ARE VIEWER-SCOPED, AND THE SPLIT IS LOAD-BEARING.
 * `PublicPost`/`PublicPostSummary`/`PublicProfile` are what an ANONYMOUS reader
 * gets — and what the edge CACHES. `AuthoredPost` is what an author gets for
 * their OWN post, drafts included, and it must never reach a shared cache. They
 * are separate types so "serve the author's view from the public route" is a
 * type error rather than a leak nobody notices.
 */
import { z } from "zod";

export const PostStatus = z.enum(["draft", "published"]);
export type PostStatusValue = z.infer<typeof PostStatus>;

/** A tag as rendered: the URL slug + the author-facing display label. */
export interface TagRef {
  slug: string;
  label: string;
}

/** ~100k characters. Bounds the render cost and the row width. */
const MARKDOWN_MAX = 100_000;

export const CreatePostInput = z.object({
  title: z.string().trim().min(1).max(200),
  markdownSource: z.string().min(1).max(MARKDOWN_MAX),
  // Default draft: publishing must be an explicit act, never the fallback of a
  // client that omitted a field.
  status: PostStatus.default("draft"),
  // Freeform labels; the server slugifies + dedupes + caps. Trim here so
  // "  ai  " -> "ai"; empty-after-trim is rejected (min(1)).
  tags: z.array(z.string().trim().min(1).max(50)).max(5).default([]),
});

export const UpdatePostInput = z.object({
  title: z.string().trim().min(1).max(200),
  markdownSource: z.string().min(1).max(MARKDOWN_MAX),
  status: PostStatus,
  // Freeform labels; the server slugifies + dedupes + caps. Trim here so
  // "  ai  " -> "ai"; empty-after-trim is rejected (min(1)).
  tags: z.array(z.string().trim().min(1).max(50)).max(5).default([]),
});

/**
 * The first-page keyset sentinel: every uuid sorts below it.
 * `WHERE id < $cursor ORDER BY id DESC` then needs no special-casing — one query
 * serves page 1 and page N, so the two cannot drift apart.
 */
export const MAX_CURSOR = "ffffffff-ffff-ffff-ffff-ffffffffffff";

/** A published post as served to an ANONYMOUS renderer. */
export interface PublicPost {
  id: string;
  authorId: string;
  username: string;
  displayName: string | null;
  title: string;
  slug: string;
  /** Rendered by the WEB Worker at read time — never stored as HTML. */
  markdownSource: string;
  publishedAt: string;
  updatedAt: string;
  tags: TagRef[];
}

export interface PublicPostSummary {
  id: string;
  title: string;
  slug: string;
  /** The first ~400 chars of markdown_source; the excerpt is derived from it. */
  excerptSource: string;
  publishedAt: string;
  updatedAt: string;
  tags: TagRef[];
}

export interface PublicProfile {
  userId: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  posts: PublicPostSummary[];
  /** The last id on this page, or null when there are no more. */
  nextCursor: string | null;
}

/** A post as served to its OWN author (drafts included). */
export interface AuthoredPost {
  id: string;
  title: string;
  slug: string;
  markdownSource: string;
  status: PostStatusValue;
  publishedAt: string | null;
  updatedAt: string;
  tags: TagRef[];
}

/** What `GET /public/recent` returns — the source for sitemap.xml + rss.xml. */
export interface RecentPost extends PublicPostSummary {
  username: string;
}

/** What `GET /public/discover` returns — the site-wide Discover feed, one keyset page. */
export interface DiscoverPage {
  posts: RecentPost[];
  /** The last id on this page, or null when there are no more. */
  nextCursor: string | null;
}

/** `GET /public/tag` — one keyset page of published posts carrying a tag. */
export interface TagPage {
  tag: TagRef;
  posts: RecentPost[];
  nextCursor: string | null;
}

/** A row in `GET /public/tags`: a tag with its published-post count. */
export interface TagCount {
  slug: string;
  label: string;
  count: number;
}
