/**
 * The zod input schema for `POST /notifications/read`, split out of
 * notifications.ts so that consumers of the PURE display helpers
 * (`collapseNotifications`, `notificationLabel`) never pull zod into their
 * bundle. See notifications.ts for the wire types and collapsing/label logic.
 */
import { z } from "zod";

/** `POST /notifications/read` — mark a set read, or all. Exactly one branch. */
export const MarkReadInput = z
  .object({
    ids: z.array(z.string().uuid()).min(1).optional(),
    all: z.literal(true).optional(),
  })
  .refine((b) => (b.all === true) !== (b.ids !== undefined), {
    message: "exactly one of ids / all",
  });
export type MarkReadValue = z.infer<typeof MarkReadInput>;
