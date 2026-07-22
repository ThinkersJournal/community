import { expect, test } from "@playwright/test";

import { chooseUsername, signUpAndVerify, uniqueHandle } from "./helpers";

test("themed shell renders with nav + footer on a public page", async ({ page }) => {
  await page.goto("/authors");
  await expect(page.locator("header.nav")).toBeVisible();
  await expect(page.locator("footer.ft")).toBeVisible();
  // wordmark links back to the apex marketing site
  await expect(page.locator('header.nav a[href="https://thinkersjournal.com/"]')).toBeVisible();
});

test("nav auth slot: logged-out shows Sign in/up; logged-in shows @handle + Sign out that clears the session", async ({ page }) => {
  // Logged out
  await page.goto("/authors");
  await expect(page.locator('[data-auth-slot] a[href="/login"]')).toBeVisible();
  await expect(page.locator('[data-auth-slot] a[href="/signup"]')).toBeVisible();

  // Sign up + onboard
  await signUpAndVerify(page, page.request);
  const handle = uniqueHandle("themer");
  await chooseUsername(page, handle);

  // Logged in — the island upgrades the slot
  await page.goto("/authors");
  const slot = page.locator("[data-auth-slot]");
  await expect(slot.getByText(`@${handle}`)).toBeVisible();
  const signOut = slot.getByRole("button", { name: "Sign out" });
  await expect(signOut).toBeVisible();

  // Sign out clears the session → back to Sign in
  await signOut.click();
  await page.waitForURL(/\/$/);
  await page.goto("/authors");
  await expect(page.locator('[data-auth-slot] a[href="/login"]')).toBeVisible();
});
