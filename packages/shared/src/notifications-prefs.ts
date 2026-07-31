/**
 * Notification email preferences (M2.3c). The zod schema is isolated in this
 * module — NEVER import it from notifications.ts, which the bell island bundles
 * onto every page. `PUT /notification-prefs` replaces the whole row, so all four
 * fields are required (no partial patch).
 */
import { z } from "zod";

export const NOTIFICATION_CHANNELS = ["instant", "digest", "off"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationPrefs {
  masterEnabled: boolean;
  direct: NotificationChannel;
  reactions: NotificationChannel;
  follows: NotificationChannel;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  masterEnabled: true,
  direct: "instant",
  reactions: "digest",
  follows: "digest",
};

const channel = z.enum(NOTIFICATION_CHANNELS);

export const NotificationPrefsInput = z.object({
  masterEnabled: z.boolean(),
  direct: channel,
  reactions: channel,
  follows: channel,
});
export type NotificationPrefsValue = z.infer<typeof NotificationPrefsInput>;
