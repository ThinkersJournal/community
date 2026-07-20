/**
 * SOCIAL-GRAPH WIRE TYPES — shared by the `api` Worker (which emits them) and
 * the `web` Worker (which renders/consumes them). Public reads are anonymous
 * and viewer-independent (safe to cache); viewer-scoped shapes (Me, FollowStatus)
 * are never cached.
 */
import { z } from "zod";

/** Chosen handles: 3–30 chars of lowercase letters, digits, underscore. */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;

export const ChooseUsernameInput = z.object({
  // Trim + lowercase BEFORE the pattern check so "  Ada  " → "ada", and casing
  // never causes a spurious reject (profiles.username is citext-unique anyway).
  username: z.string().trim().toLowerCase().regex(USERNAME_PATTERN),
});
export type ChooseUsernameValue = z.infer<typeof ChooseUsernameInput>;

export const FollowInput = z.object({
  followeeId: z.string().uuid(),
});
export type FollowValue = z.infer<typeof FollowInput>;

/** `GET /profile/me` — the signed-in viewer's own handle + onboarding state. */
export interface Me {
  username: string;
  usernameChosen: boolean;
}

/** `GET /public/social` — viewer-independent counts. */
export interface SocialCounts {
  followersCount: number;
  followingCount: number;
}

/** A row in a follower/following list. */
export interface FollowUser {
  username: string;
  displayName: string | null;
}

/** `GET /public/followers` / `GET /public/following` — keyset page of users. */
export interface FollowList {
  users: FollowUser[];
  /** The last follows.id on this page, or null when there are no more. */
  nextCursor: string | null;
}

/** `GET /follows/status?id=…&id=…` — the subset of ids the viewer follows. */
export interface FollowStatusResult {
  following: string[];
}

/** A feed card: a published post plus its author's handle. */
export interface FeedPost {
  id: string;
  title: string;
  slug: string;
  excerptSource: string;
  publishedAt: string;
  updatedAt: string;
  username: string;
  displayName: string | null;
}

/** `GET /feed` — keyset page of feed cards. */
export interface Feed {
  posts: FeedPost[];
  /** The last post id on this page, or null when there are no more. */
  nextCursor: string | null;
}

/** A recently-active author for the discovery page. */
export interface AuthorSummary {
  /** Public, viewer-independent — safe to embed in cached HTML for the Follow island. */
  userId: string;
  username: string;
  displayName: string | null;
  /** This author's latest published post id — also the keyset cursor. */
  latestPostId: string;
}

/** `GET /public/authors` — keyset page of recent authors. */
export interface AuthorsPage {
  authors: AuthorSummary[];
  /** The last author's latestPostId on this page, or null when there are no more. */
  nextCursor: string | null;
}
