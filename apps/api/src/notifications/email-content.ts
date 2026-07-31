/**
 * Render a recipient's collapsed notifications into a Postmark email body (M2.3c).
 * Reuses the SAME shared copy helpers as the bell (notificationLabel/Href) so
 * email and in-app wording can never diverge. Every user-derived value is
 * escapeHtml'd. Links are absolutized against the canonical origin; a null href
 * (deleted post) renders as plain text.
 */
import { CANONICAL_ORIGIN, escapeHtml } from "../auth/email-verify";
import { collapseNotifications, notificationHref, notificationLabel } from "@thinkersjournal/shared";
import type { CollapsedNotification, NotificationItem } from "@thinkersjournal/shared";

function lineText(g: CollapsedNotification): string {
  const l = notificationLabel(g);
  return `${l.leadName}${l.rest}`;
}
function absHref(g: CollapsedNotification): string | null {
  const href = notificationHref(g);
  return href === null ? null : `${CANONICAL_ORIGIN}${href}`;
}

export function buildNotificationEmail(
  items: NotificationItem[],
  opts: { unsubUrl: string; disposition: "instant" | "digest" },
): { subject: string; textBody: string; htmlBody: string } {
  const groups = collapseNotifications(items);

  const subject =
    opts.disposition === "digest"
      ? `Your Thinkers Journal digest — ${groups.length} update${groups.length === 1 ? "" : "s"}`
      : groups.length === 1
        ? lineText(groups[0]!)
        : `You have ${groups.length} new notifications`;

  const textLines = groups.map((g) => {
    const href = absHref(g);
    return href === null ? lineText(g) : `${lineText(g)}\n  ${href}`;
  });
  const textBody =
    `${textLines.join("\n\n")}\n\n—\nManage preferences: ${CANONICAL_ORIGIN}/settings/notifications\nUnsubscribe: ${opts.unsubUrl}\n`;

  const htmlItems = groups
    .map((g) => {
      const href = absHref(g);
      const text = escapeHtml(lineText(g));
      return href === null ? `<li>${text}</li>` : `<li><a href="${escapeHtml(href)}">${text}</a></li>`;
    })
    .join("");
  const htmlBody =
    `<ul>${htmlItems}</ul>` +
    `<p style="color:#888;font-size:13px">` +
    `<a href="${escapeHtml(`${CANONICAL_ORIGIN}/settings/notifications`)}">Manage preferences</a> · ` +
    `<a href="${escapeHtml(opts.unsubUrl)}">Unsubscribe</a></p>`;

  return { subject, textBody, htmlBody };
}
