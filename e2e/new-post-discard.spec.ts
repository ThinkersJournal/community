import { expect, test } from "@playwright/test";

import { publishPost, signUpAndVerify } from "./helpers";

/**
 * #71 — THE EDITOR'S DISCARD CONFIRM. Before this, a brand-new post in
 * progress had no exit but navigating away with no confirmation and no
 * indication whether a draft was left behind. The fix is a two-step
 * <details>/<summary> confirm, the SAME no-JS pattern Delete already uses —
 * PM review flagged a plain one-click link as the worst kind of destructive
 * control (it reads as harmless, behaves like Delete). Proves the real thing
 * a source/structure test can't: the first click only opens the confirm and
 * changes nothing; only the SECOND click actually leaves, and for an
 * existing post it never deletes anything — only Delete's own confirm does.
 */

test("a NEW post: opening the confirm changes nothing; confirming leaves without saving", async ({
  page,
  request,
}) => {
  await signUpAndVerify(page, request);

  await page.goto("/new-post");
  await page.fill("#title", "Never Saved");
  await page.fill("#markdownSource", "this should never be persisted");

  // Step 1 — opens the disclosure only. Still on the editor, text untouched.
  await page.getByText("Discard", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Yes, discard", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/new-post$/);
  await expect(page.locator("#title")).toHaveValue("Never Saved");

  // Step 2 — the actual navigation.
  await page.getByRole("link", { name: "Yes, discard", exact: true }).click();
  await expect(page).toHaveURL(/\/feed$/);

  // Nothing was saved — going back to a fresh /new-post shows an empty form,
  // not the abandoned draft.
  await page.goto("/new-post");
  await expect(page.locator("#title")).toHaveValue("");
});

test("an EXISTING post: 'Discard changes' reloads the saved version behind its own confirm — it does NOT delete the post", async ({
  page,
  request,
}) => {
  // publishPost requires an already-signed-in caller (see its own header) —
  // dropped when the Codacy "unused request" fix removed this call along
  // with the param, not just the param. Caught by the e2e failure this
  // produced, not by review: "publishPost: /api/me returned no username".
  await signUpAndVerify(page, request);

  const { postId, url } = await publishPost(page, {
    title: "Untouched By Discard",
    markdownSource: "original body",
  });

  await page.goto(`/new-post?post=${encodeURIComponent(postId)}`);
  await page.fill("#markdownSource", "an edit nobody will save");

  await page.getByText("Discard changes", { exact: true }).click();
  const confirm = page.getByRole("link", { name: "Yes, discard changes" });
  await expect(confirm).toBeVisible();
  // Still unsaved-and-edited before confirming — the disclosure alone must
  // not have navigated anywhere.
  await expect(page.locator("#markdownSource")).toHaveValue("an edit nobody will save");

  await confirm.click();
  // A plain substring check, deliberately NOT `new RegExp(...)` built from
  // `postId` — a dynamically-constructed RegExp from external-shaped input
  // is a needless pattern to reach for when an exact suffix is already known.
  await page.waitForURL((u) => u.pathname === "/new-post" && u.searchParams.get("post") === postId);
  // The RELOADED editor shows the ORIGINAL saved body, not the abandoned edit.
  await expect(page.locator("#markdownSource")).toHaveValue("original body");

  // And the post itself is still live at its public URL — discard never
  // touched the row Delete's own confirm exists to remove.
  const response = await page.request.get(url);
  expect(response.status()).toBe(200);
});
