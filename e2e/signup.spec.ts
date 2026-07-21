/**
 * THE M0 ACCEPTANCE TEST: a real browser drives signup -> verify -> post across
 * BOTH Workers, against real Postgres and real workerd.
 *
 * Everything else in this repo tests a layer. This tests the SPINE, and it is
 * the only thing that exercises the pieces that only exist between the layers:
 * the browser actually storing the session cookie, the `web` Worker forwarding
 * it over the Service Binding, the api resolving a session from it, the CSRF
 * token round-tripping through rendered HTML, and the soft gate flipping from
 * closed to open when — and only when — the email is verified.
 *
 * ⚠️ THE SIGNUP -> VERIFY SEQUENCE NOW LIVES IN e2e/helpers.ts (`signUpAndVerify`),
 * so e2e/publish.spec.ts can reuse it instead of copying it. This file's OWN
 * assertions are unchanged — test 1 still proves a verified user can post, test 2
 * still proves the unverified soft gate is closed. The browser still only ever
 * visits :8787; the api is touched exactly once (reading the token) inside the
 * helper, standing in for the email inbox we have no access to.
 */
import { expect, test } from "@playwright/test";

import { chooseUsername, signUp, signUpAndVerify, uniqueEmail, uniqueHandle } from "./helpers";

test.describe("signup -> verify -> post, across both Workers", () => {
  test("a verified user can create a post", async ({ page, request }) => {
    // ---- 1-3. Sign up, read the token, verify (the extracted spine) ---------
    // signUpAndVerify performs — and asserts — the whole sequence this test used
    // to inline: the 'check your email' state, the browser actually STORING the
    // tj_session cookie, and #verified after the session-carrying verify hop.
    await signUpAndVerify(page, request);

    // ⚠️ MILESTONE-REVIEW ADDITION. new-post.astro now gates the editor
    // FORM itself on having a chosen handle (the content-loss fix — see
    // e2e/social.spec.ts's onboarding test) — a not-yet-onboarded visitor
    // gets a "choose your handle" prompt, not `#title`/`#markdownSource`.
    // This test's payoff is specifically about the EMAIL-VERIFICATION soft
    // gate, not the handle gate, so onboard here to reach the form at all;
    // the handle gate itself is proven separately by social.spec.ts.
    await chooseUsername(page, uniqueHandle("verified"));

    // ---- 4. THE PAYOFF: posting now succeeds --------------------------------
    // Identical to the negative case below in every respect except that this
    // user verified. The soft gate is the only difference between them.
    // ⚠️ "Save draft" (name="intent" value="draft"), not "Publish": publishing
    // redirects away to /@user/slug (Task 17), which would make this case
    // about the redirect target rather than about the soft gate the test
    // exists to prove. The draft/publish CHOICE itself is proven server-side
    // by apps/api/test/posts.test.ts; this spine test only needs ONE of them
    // to reach the payoff assertion below. (The publish -> public-render path
    // is covered end-to-end in e2e/publish.spec.ts.)
    await page.goto("/new-post");
    await page.fill('input[name="title"]', "My first post");
    await page.fill('textarea[name="markdownSource"]', "Written by a verified account.");
    await page.click('button[name="intent"][value="draft"]');

    await expect(
      page.locator("#saved"),
      "a VERIFIED user could not create a post",
    ).toBeVisible();
    // And specifically NOT blocked by the soft gate.
    await expect(page.locator("#unverified")).toHaveCount(0);
  });

  /**
   * ⚠️ THE NEGATIVE — this is what makes the test above mean something.
   *
   * Without it, "verified user can post" would still pass if the soft gate were
   * deleted entirely, and the whole verification step would be decorative. This
   * proves the gate is CLOSED before verification, so the case above proves
   * verification is what OPENS it.
   *
   * Uses its own fresh, unverified account rather than reordering the flow
   * above: verification is one-way, so a single account cannot demonstrate both
   * sides, and posting-then-verifying in one test would leave the failure
   * ambiguous. Calls `signUp` (NOT `signUpAndVerify`) precisely to stop BEFORE
   * verification.
   *
   * ⚠️ MILESTONE-REVIEW REWRITE. This used to fill the editor form directly
   * and assert `#unverified`. new-post.astro's new content-loss fix gates the
   * FORM ITSELF on having a chosen handle — so an unverified user, who is
   * *also* never onboarded (handle.astro's soft gate on this file — see
   * apps/api/src/routes/username.ts's `handleChooseUsername`, which itself
   * requires `requireVerifiedEmail: true` — is unreachable without a
   * verified email), now never even sees `#title`/`#markdownSource` to fill.
   * The underlying security property THIS TEST EXISTS TO PROVE — an
   * unverified user cannot get a post published — still holds, and holds
   * more strongly (blocked at editor-open, before any content is typed, not
   * just at submit); this rewrite proves it via the mechanism that ACTUALLY
   * blocks them now: the onboarding prompt, and — one level down — the SAME
   * EMAIL_NOT_VERIFIED soft gate this test always meant to exercise, now
   * surfaced on /choose-username instead of on /new-post's own POST handler.
   */
  test("an UNVERIFIED user is blocked from posting by the soft gate", async ({
    page,
  }) => {
    const email = uniqueEmail("unverified");

    await signUp(page, email);
    await expect(page.locator("#check-email")).toBeVisible();

    // Authenticated (the signup minted a session) but NOT verified. Deliberately
    // no /verify-email visit.
    await page.goto("/new-post");

    // Blocked before the form even exists — not onboarded (and, one level
    // down, CANNOT onboard while unverified; asserted next).
    await expect(page.locator("#onboarding-required")).toBeVisible();
    await expect(page.locator("#editor-form")).toHaveCount(0);
    await expect(page.locator('input[name="title"]')).toHaveCount(0);

    // Following the prompt confirms WHY: choosing a handle itself demands a
    // verified email — the same soft gate this test always meant to prove,
    // now enforced one hop earlier.
    await page.click('a[href="/choose-username?next=/new-post"]');
    await page.fill('input[name="username"]', uniqueHandle("stillunverified"));
    await page.click('button[type="submit"]');

    await expect(
      page.locator("#error"),
      "an UNVERIFIED user was not stopped by the email-verification soft gate on /choose-username",
    ).toContainText("verify your email");
    // Still on /choose-username, not redirected anywhere — no handle was
    // claimed and no post could ever have been created.
    await expect(page).toHaveURL(/\/choose-username/);
  });
});
