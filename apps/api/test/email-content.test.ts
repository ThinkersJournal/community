import { describe, expect, it } from "vitest";
import { buildNotificationEmail } from "../src/notifications/email-content";
import type { NotificationItem } from "@thinkersjournal/shared";

function item(over: Partial<NotificationItem>): NotificationItem {
  return {
    id: crypto.randomUUID(), kind: "post_comment",
    actor: { username: "ada", displayName: "Ada" },
    postId: "p1", postTitle: "On Method", postSlug: "on-method",
    postAuthorUsername: "me", commentId: "c1", reactionKind: null,
    createdAt: "2026-07-31T00:00:00Z", read: false, ...over,
  };
}
const U = "https://community.thinkersjournal.com/unsub?token=z";

describe("buildNotificationEmail", () => {
  it("instant single-group subject is the label sentence", () => {
    const e = buildNotificationEmail([item({})], { unsubUrl: U, disposition: "instant" });
    expect(e.subject).toContain("Ada");
    expect(e.subject).toContain("On Method");
    expect(e.htmlBody).toContain("https://community.thinkersjournal.com/@me/on-method");
    expect(e.htmlBody).toContain(U);
  });
  it("instant multi-group subject counts groups", () => {
    const e = buildNotificationEmail(
      [item({}), item({ kind: "follow", postId: null, postSlug: null, commentId: null, actor: { username: "bo", displayName: "Bo" } })],
      { unsubUrl: U, disposition: "instant" });
    expect(e.subject).toBe("You have 2 new notifications");
  });
  it("digest subject uses the digest wording", () => {
    const e = buildNotificationEmail([item({})], { unsubUrl: U, disposition: "digest" });
    expect(e.subject.toLowerCase()).toContain("digest");
  });
  it("escapes a malicious post title", () => {
    const e = buildNotificationEmail([item({ postTitle: '<script>x</script>' })], { unsubUrl: U, disposition: "instant" });
    expect(e.htmlBody).not.toContain("<script>x</script>");
    expect(e.htmlBody).toContain("&lt;script&gt;");
  });
  it("escapes a malicious slug so it cannot break out of the href attribute", () => {
    const e = buildNotificationEmail(
      [item({ postSlug: 'x"><script>evil</script>' })],
      { unsubUrl: U, disposition: "instant" },
    );
    // The raw breakout sequence must not survive into the attribute value.
    expect(e.htmlBody).not.toContain('x"><script>');
    // Both the quote and the tag delimiters must be escaped.
    expect(e.htmlBody).toContain("&quot;");
    expect(e.htmlBody).toContain("&lt;script&gt;");
  });
  it("renders a null href (deleted post) as plain text, not a link", () => {
    const e = buildNotificationEmail(
      [item({ postAuthorUsername: null, postSlug: null, postTitle: "Gone" })],
      { unsubUrl: U, disposition: "instant" },
    );
    const listMarkup = e.htmlBody.slice(0, e.htmlBody.indexOf("</ul>") + "</ul>".length);
    expect(listMarkup).not.toContain("<a");
    expect(listMarkup).toContain("<li>");
    expect(listMarkup).toContain("Gone");
  });
});
