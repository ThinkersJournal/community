/**
 * THE NOTIFICATION SPINE — a real browser drives an engagement on one user's
 * content and asserts the OTHER user's nav bell reflects it, across both Workers
 * and real Postgres. Poll-delivered: the bell fetches /api/notifications-count,
 * so "the badge shows 1" here is the DB-backed count (no realtime yet — that is
 * M2.3b). No Workers Cache is involved (these are all no-store/markPrivate).
 */
import { expect, test } from "@playwright/test";

import { chooseUsername, publishPost, signUpAndVerify, toggleFollowTo, uniqueHandle } from "./helpers";

test("comment → author's bell shows 1 → open → read → clears; follow bumps it again", async ({
  page,
  browser,
}) => {
  // ---- Author A publishes --------------------------------------------------
  await signUpAndVerify(page, page.request);
  const { url, username: authorHandle } = await publishPost(page, {
    title: "Notify Me",
    markdownSource: "body",
  });

  // ---- Reader B comments on A's post ---------------------------------------
  const bCtx = await browser.newContext();
  try {
    const b = await bCtx.newPage();
    await signUpAndVerify(b, b.request);
    await chooseUsername(b, uniqueHandle("reader"));

    await b.goto(url);
    const form = b.locator("[data-comment-form-slot] form");
    await form.locator("textarea").fill("great post");
    await form.locator("button[type=submit]").click();
    await expect(b.locator(".comment-body").first()).toContainText("great post");

    // ---- A reloads any page; the nav bell reflects the new notification ----
    // (the island polls on load/visibilitychange/60s, so A must navigate to
    // pick up the new count rather than relying on the background poll here.)
    await page.goto("/feed");
    const bell = page.locator("[data-notify-bell]");
    await expect(bell).toBeVisible();
    await expect(page.locator("[data-notify-badge]")).toHaveText("1");

    // ---- A opens the dropdown → sees the comment notification → clears -----
    await page.locator("[data-notify-toggle]").click();
    await expect(page.locator("[data-notify-panel]")).toContainText("commented");
    await expect(page.locator("[data-notify-badge]")).toBeHidden();

    // ---- A reloads → still cleared (server persisted the read) -------------
    await page.reload();
    await expect(bell).toBeVisible();
    await expect(page.locator("[data-notify-badge]")).toBeHidden();

    // ---- B follows A → the badge returns ------------------------------------
    // A's handle comes straight from publishPost's return value — more robust
    // than clicking a byline link (the brief's fallback), and it is the
    // brief's own preferred approach.
    // (toggleFollowTo tolerates the E2E dev-harness's lost-follow-response
    // stall; see its doc in helpers.ts.)
    await b.goto(`/@${authorHandle}`);
    await toggleFollowTo(b, "Unfollow");

    await page.reload();
    await expect(page.locator("[data-notify-badge]")).toHaveText("1");
  } finally {
    await bCtx.close();
  }
});
