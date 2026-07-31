/**
 * The kind → category mapping (M2.3c). PURE and zod-free: shared by the email
 * drain (api) and any web surface. The three categories are the units the user
 * sets an email channel for (direct/reactions/follows). Adding a new
 * NotificationKind is a compile error here until it is mapped — deliberately.
 */
import type { NotificationKind } from "./notifications";

export type NotificationCategory = "direct" | "reactions" | "follows";

export function categoryForKind(kind: NotificationKind): NotificationCategory {
  switch (kind) {
    case "post_comment":
    case "comment_reply":
      return "direct";
    case "post_reaction":
    case "comment_reaction":
      return "reactions";
    case "follow":
      return "follows";
  }
}
