import { expect, test } from "@playwright/test";

import { publishPost, signUpAndVerify, uniqueHandle } from "./helpers";

test("a published post appears on the community Discover home feed", async ({ page, request }) => {
  await signUpAndVerify(page, request);
  // A distinctive, unlikely-to-collide title so the assertion is unambiguous in
  // the shared, accumulating test DB.
  const title = `Discoverable Fieldnote ${uniqueHandle("d")}`;
  await publishPost(page, { title, markdownSource: "a discoverable body about widgets" });

  await page.goto("/");
  // Scoped to <main> (not the nav/footer chrome): the post's card heading is
  // present on the Discover feed.
  await expect(page.locator("main").getByRole("heading", { name: title })).toBeVisible();
});
