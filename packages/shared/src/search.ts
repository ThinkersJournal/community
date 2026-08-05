/**
 * Search wire types (M2.4a). Anonymous /public/search returns one page of either
 * posts or people (the tab the caller asked for), offset-paginated with a
 * hasMore-derived nextOffset (no total count).
 */
export const SEARCH_TYPES = ["posts", "people"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchPostResult {
  id: string;
  title: string;
  slug: string;
  /** left(markdown_source, 400) — raw markdown; render via markdownExcerpt (never set:html). */
  excerptSource: string;
  publishedAt: string;
  authorUsername: string;
  authorDisplayName: string | null;
}

export interface SearchPersonResult {
  username: string;
  displayName: string | null;
  bio: string | null;
}

export interface SearchPage<T> {
  results: T[];
  /** The offset for the next page, or null when there is no next page (incl. at the offset cap). */
  nextOffset: number | null;
}

export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_Q_MIN = 2;
export const SEARCH_Q_MAX = 100;
export const SEARCH_MAX_OFFSET = 200;
