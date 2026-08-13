/**
 * M2.3C E2E SPINE — settings persistence + the bell's seen-vs-read split.
 *
 * ⚠️ NO EMAIL ASSERTIONS HERE, DELIBERATELY. The dev harness's
 * `POSTMARK_SERVER_TOKEN` is a dummy (playwright.config.ts), so every real send
 * fails and is logged ("postmark send failed") — there is no inbox this suite
 * can read and no way to observe a send from the browser. What IS observable
 * from the browser, and what this file proves instead:
 *
 *  1. `/settings/notifications` actually persists a preference change through
 *     the api's `PUT /notification-prefs` and reads it back on a fresh GET —
 *     the native `<form method="POST">` round trip (Task 9), not a stub.
 *  2. The nav bell's M2.3c seen/read split (notify-bell.ts): opening the
 *     dropdown advances the SEEN watermark (`POST /api/notifications-seen`,
 *     clears the badge) but a rendered row stays styled `.unread` until a
 *     CLICK-THROUGH marks it read (`POST /api/notifications-read`, which this
 *     test never triggers) — badge-cleared and row-unread must coexist.
 *
 * Real send-stamping (`emailed_at` transitioning null->set on a successful
 * Postmark call) is covered by Task 8's `apps/api/test/email-drain.test.ts`
 * under `cloudflare:test`, which stubs Postmark to succeed. Do not duplicate
 * that here — nor try to reproduce it, since it is unobservable in this harness.
 *
 * Selectors are taken from the current DOM, not guessed:
 *  - Comment form: `[data-comment-form-slot] form` -> `textarea` / `button[type=submit]`
 *    (apps/web/src/pages/[handle]/[slug].astro + comments.ts's `buildForm`) —
 *    the same idiom e2e/post-live.spec.ts and e2e/notifications.spec.ts use.
 *  - Bell: `[data-notify-bell]` / `[data-notify-toggle]` / `[data-notify-badge]` /
 *    `[data-notify-panel]`, rows `.notify-row` (read) / `.notify-row.unread`
 *    (unread) — apps/web/src/components/Nav.astro + notify-bell.ts's `renderPanel`.
 *  - Settings form: `select[name="reactions"]`, `button[type="submit"]`, the
 *    saved notice `.ok` — apps/web/src/pages/settings/notifications.astro.
 */
import { expect, test } from "@playwright/test";

import { publishPost, signUpAndVerify } from "./helpers";

test("notification settings persist across reload", async ({ page, request }) => {
  await signUpAndVerify(page, request);

  // Save prefs: turn Reactions off.
  await page.goto("/settings/notifications");
  await page.selectOption('select[name="reactions"]', "off");
  await page.click('button[type="submit"]');
  await expect(page.locator(".ok")).toBeVisible();

  // A fresh GET (reload) round-trips the saved value from the api, not a
  // client-side echo of what was just submitted.
  await page.goto("/settings/notifications");
  await expect(page.locator('select[name="reactions"]')).toHaveValue("off");
});

test("opening the bell clears the badge (seen) but does not mark rows read", async ({
  page,
  request,
  browser,
}) => {
  // ---- A publishes a post (the handle comes from signup). -----------------
  await signUpAndVerify(page, request);
  const post = await publishPost(page, { title: "Live", markdownSource: "hello" });

  // ---- B signs up (handle-at-signup: no separate onboarding step) and -----
  // top-level-comments on A's post -> A gets one notification. ---------------
  const ctxB = await browser.newContext();
  try {
    const b = await ctxB.newPage();
    await signUpAndVerify(b, b.request);
    await b.goto(post.url);

    const form = b.locator("[data-comment-form-slot] form");
    await form.locator("textarea").fill("great post");
    await form.locator("button[type=submit]").click();
    await expect(b.locator(".comment-body").first()).toContainText("great post");

    // ---- A: badge shows 1, open the bell -> badge clears (seen), row stays
    // styled unread (no click-through happened). ------------------------------
    await page.goto("/feed");
    await expect(page.locator("[data-notify-bell]")).toBeVisible();
    const badge = page.locator("[data-notify-badge]");
    await expect(badge).toHaveText("1");

    await page.click("[data-notify-toggle]");
    await expect(page.locator("[data-notify-panel] .notify-row")).toHaveCount(1);
    await expect(badge).toBeHidden(); // seen cleared the badge
    await expect(page.locator("[data-notify-panel] .notify-row.unread")).toHaveCount(1); // not read
  } finally {
    await ctxB.close();
  }
});
