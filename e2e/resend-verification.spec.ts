/**
 * THE REVOCATION-COOKIE E2E for `POST /auth/resend-verification` (M1 Task 10).
 *
 * ⚠️ WHAT THIS COVERS THAT NOTHING ELSE CAN, AND WHY IT IS A BROWSER TEST.
 * The api's vitest suite proves the api answers a revoked session with a 401
 * carrying a `Set-Cookie` that clears the dead cookie. It cannot prove the `web`
 * Worker PROPAGATES that header, nor that the browser actually drops the cookie
 * — and dropping it is a page-level responsibility (`applyCookies`) that is
 * invisible to every other layer. This is the same bug class as the M0 blocker
 * where `Astro.redirect()` silently discarded the login `Set-Cookie`: everything
 * looks fine, the status is right, and the browser is left replaying a session
 * that can only ever 401 again. `apps/web` has no unit test for any .astro page
 * (`apiFetch` imports `env` from `cloudflare:workers`, which does not resolve
 * outside workerd), so a browser test is the honest place for this.
 *
 * ⚠️ WHY THE REVOCATION MUST LAND *BETWEEN* RENDER AND SUBMIT. `GET /auth/csrf`
 * runs the epoch check too (`readCurrentSession`), so a session that is ALREADY
 * stale when the page renders gets no CSRF token and the resend form is not
 * rendered at all. The 401-with-cleared-cookie path is therefore reachable in
 * exactly one window: the session died after the form was rendered and before it
 * was submitted — the "logged out everywhere from another tab" case. This test
 * constructs that window deliberately; a simpler ordering would silently test
 * nothing.
 *
 * ⚠️ THE BROWSER ONLY EVER VISITS :8787, like e2e/signup.spec.ts. There is not a
 * single direct api call here — the revocation is driven entirely through a
 * SECOND browser context re-signing-up the same address, which is a real user
 * action with a real UI.
 */
import { expect, test } from "@playwright/test";

/** Satisfies the api's zod schema (>= 12 chars). Not what this test is about. */
const PASSWORD = "correct-horse-battery-staple";

/**
 * A brand-new address per run — the E2E writes through the real signup path into
 * the real dev database and those rows PERSIST (see e2e/signup.spec.ts's note).
 */
function uniqueEmail(prefix: string): string {
  return `e2e-${prefix}-${crypto.randomUUID()}@example.com`;
}

/**
 * Sign up through the real form in the real browser.
 *
 * Deliberately a small local copy rather than an import from
 * e2e/signup.spec.ts: importing a spec module would REGISTER that file's tests
 * a second time. It is 5 lines of form-filling with no security property to
 * drift — unlike apps/api/test/actor.ts, which was extracted precisely because
 * it carries one (the epoch subtlety its header describes).
 */
async function signUp(
  page: import("@playwright/test").Page,
  email: string,
): Promise<void> {
  await page.goto("/signup");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="turnstileToken"]', "dummy-turnstile-token");
  await page.click('button[type="submit"]');
  await expect(page.locator("#check-email")).toBeVisible();
}

test.describe("resend verification, across both Workers", () => {
  test("a session revoked between render and submit is cleanly logged out", async ({
    browser,
  }) => {
    const email = uniqueEmail("resend-revoked");

    // ---- 1. The victim's browser signs up: session S1, unverified ----------
    const victim = await browser.newContext();
    const victimPage = await victim.newPage();
    await signUp(victimPage, email);

    // ---- 2. The resend form renders — S1 is live, so /auth/csrf issues -----
    // No `?token=`: the page renders "no token supplied" AND the resend form,
    // which is the real "my link never arrived, let me ask for another" flow.
    await victimPage.goto("/verify-email");
    await expect(
      victimPage.locator('button[type="submit"]'),
      "the resend form did not render for a live session — GET /auth/csrf should have issued a token",
    ).toBeVisible();
    expect(
      (await victim.cookies()).find((c) => c.name === "tj_session"),
      "the victim's browser never stored a session cookie — check the cookie's Domain/Secure attributes for dev",
    ).toBeDefined();

    // ---- 3. S1 is REVOKED, after the form was rendered ---------------------
    // Re-signup over the same still-UNVERIFIED address takes the account over
    // and bumps its security epoch (step 6 of apps/api/src/routes/signup.ts),
    // which revokes every outstanding session for it — S1 included. A separate
    // browser context, so this never touches the victim's cookie jar.
    const attacker = await browser.newContext();
    await signUp(await attacker.newPage(), email);

    // ---- 4. The victim clicks "resend" holding the now-dead S1 -------------
    await victimPage.click('button[type="submit"]');

    await expect(
      victimPage.locator("#resend-unauthenticated"),
      "a revoked session's resend did not render the logged-out state",
    ).toBeVisible();

    // ---- 5. THE PAYOFF: the dead cookie is GONE from the browser -----------
    // The api cleared it (pipeline step 4 -> `unauthorized({"Set-Cookie": ...})`)
    // and verify-email.astro must have propagated that header via applyCookies.
    // Without the applyCookies call this assertion fails while EVERY other one
    // above still passes — which is exactly how the bug hid.
    expect(
      (await victim.cookies()).find((c) => c.name === "tj_session"),
      "the browser is still holding a DEAD session cookie — verify-email.astro must applyCookies() the resend response (see new-post.astro:74 for the same guard)",
    ).toBeUndefined();

    await victim.close();
    await attacker.close();
  });
});
