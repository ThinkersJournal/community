import { expect, test } from "@playwright/test";

import { API_URL } from "../playwright.config";
import { PASSWORD, signUpAndVerify } from "./helpers";

import type { APIRequestContext } from "@playwright/test";

/**
 * #70 — THE PASSWORD-RESET SPINE. A real browser drives signup -> verify ->
 * "forgot password" -> reset -> the new password actually works, and the OLD
 * one no longer does, through the `web` Worker, which reaches `api` only
 * over the Service Binding.
 *
 * ⚠️ Reads the reset token via `GET /__test/last-reset-token` — the SAME
 * test-only seam `readVerificationToken` (e2e/helpers.ts) uses for
 * verification tokens, standing in for reading the emailed link (Postmark's
 * dev secret makes the real send fail by design; see that function's own
 * comment). Direct api call, on :8788 — the only other place this harness
 * does that.
 */

async function readResetToken(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${API_URL}/__test/last-reset-token`);
  expect(
    response.status(),
    "GET /__test/last-reset-token failed — did the forgot-password request succeed, and is TEST_ROUTES=1 set on the api dev server?",
  ).toBe(200);
  const token = (await response.text()).trim();
  expect(token, "reset token was empty").not.toBe("");
  return token;
}

test("forgot password -> reset -> new password works, old one no longer does", async ({ page, request }) => {
  const { email } = await signUpAndVerify(page, request);

  // ---- Request a reset -------------------------------------------------
  await page.goto("/forgot-password");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="turnstileToken"]', "dummy-token");
  await page.click('button[type="submit"]');
  await expect(page.locator("#sent")).toBeVisible();

  const token = await readResetToken(request);
  const newPassword = "a-brand-new-e2e-password";

  // ---- Redeem it ---------------------------------------------------------
  await page.goto(`/reset-password?token=${encodeURIComponent(token)}`);
  await page.fill('input[name="password"]', newPassword);
  await page.click('button[type="submit"]');

  // Success redirects to "/" and logs the user in with the new session —
  // same Set-Cookie-carrying-302 shape login.astro uses.
  await expect(page).toHaveURL(/\/$/);

  // ---- The reset invalidated every prior session ------------------------
  // signUpAndVerify's own browser context session predates the reset, so it
  // must be dead now — logging out and back in with the OLD password proves
  // it (login.astro shows a generic invalid-credentials error either way,
  // same enumeration-safety shape as everywhere else in this app).
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.locator("#error")).toBeVisible();

  // ---- The NEW password logs in ------------------------------------------
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', newPassword);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/$/);
});

test("⚠️ forgot-password never reveals whether an email is registered — same message either way", async ({
  page,
}) => {
  await page.goto("/forgot-password");
  await page.fill('input[name="email"]', "definitely-not-registered-e2e@example.com");
  await page.fill('input[name="turnstileToken"]', "dummy-token");
  await page.click('button[type="submit"]');

  // The SAME success state a registered email gets — no distinguishing
  // error, no different copy. See apps/api/src/routes/forgot-password.ts's
  // header for why.
  await expect(page.locator("#sent")).toBeVisible();
});
