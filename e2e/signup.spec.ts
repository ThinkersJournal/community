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
 * ⚠️ THE BROWSER ONLY EVER VISITS :8787 (the `web` Worker). The api is touched
 * exactly ONCE, out of band, to read the verification token — standing in for
 * the email inbox we have no access to. See `readVerificationToken`. Every
 * assertion below is made against what a user would actually see. Do not add
 * direct api calls: vitest already covers the api, and nothing else covers this.
 */
import { expect, test } from "@playwright/test";

import { API_URL } from "../playwright.config";

/**
 * A password that satisfies the api's zod schema (>= 12 chars). Shared by both
 * cases: the password is not what either test is about.
 */
const PASSWORD = "correct-horse-battery-staple";

/**
 * A brand-new address for every run.
 *
 * ⚠️ NOT a fixed address, and NOT cleaned up. The E2E writes through the real
 * signup path into the real dev database and those rows PERSIST, so a constant
 * email would 409 ("already registered") on the second run — the suite would
 * pass exactly once and then fail forever. A random address also keeps
 * concurrent runs from colliding, and keeps this suite from truncating tables
 * out from under `pnpm --filter @thinkersjournal/api test`, which uses a
 * different database but the same server.
 */
function uniqueEmail(prefix: string): string {
  return `e2e-${prefix}-${crypto.randomUUID()}@example.com`;
}

/**
 * Read the token the api just emailed — the one step a browser cannot do.
 *
 * In production the user gets this from their inbox. Here Postmark is
 * configured with a dummy token so the send FAILS (by design: it logs and
 * returns, because a mail failure must never 500 a signup), and the api instead
 * stashes the raw token in KV for `GET /__test/last-verify-token` to hand back.
 * That route only exists when `TEST_ROUTES === "1"`; in production it 404s like
 * any path that was never defined.
 *
 * ⚠️ Hits the api DIRECTLY on :8788 because it must: the route lives on the api,
 * and the `web` Worker neither proxies it nor should. This is the ONLY direct
 * api call in this file.
 */
async function readVerificationToken(
  request: import("@playwright/test").APIRequestContext,
): Promise<string> {
  const response = await request.get(`${API_URL}/__test/last-verify-token`);

  // A 404 here means either "no token issued" (the signup silently failed) or
  // TEST_ROUTES is unset. Both are setup faults, not assertion failures — say so
  // rather than letting an empty token produce a baffling "invalid link" later.
  expect(
    response.status(),
    "GET /__test/last-verify-token failed — did signup succeed, and is TEST_ROUTES=1 set on the api dev server?",
  ).toBe(200);

  const token = (await response.text()).trim();
  expect(token, "verification token was empty").not.toBe("");
  return token;
}

/** Sign up through the real form in the real browser. */
async function signUp(
  page: import("@playwright/test").Page,
  email: string,
): Promise<void> {
  await page.goto("/signup");

  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  // A real Turnstile widget (M1) will populate this; for now it is a plain
  // input, and the api runs with Cloudflare's always-passes dummy secret, so
  // any non-empty value clears the bot check.
  await page.fill('input[name="turnstileToken"]', "dummy-turnstile-token");

  await page.click('button[type="submit"]');
}

test.describe("signup -> verify -> post, across both Workers", () => {
  test("a verified user can create a post", async ({ page, request }) => {
    const email = uniqueEmail("happy");

    // ---- 1. Sign up ---------------------------------------------------------
    await signUp(page, email);

    await expect(
      page.locator("#check-email"),
      "signup did not reach the 'check your email' state",
    ).toBeVisible();

    // ⚠️ THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BLOCKER. The api
    // mints the session on 201, `web` propagates the Set-Cookie, and the browser
    // must actually STORE it. With production cookie attributes
    // (`Domain=.thinkersjournal.com; Secure`) no browser can store it on
    // http://127.0.0.1 — it is silently dropped, and every step below fails with
    // a misleading "please log in". Pinned here so that failure is named at the
    // point it happens. (apps/api/src/auth/session.ts relaxes exactly those two
    // attributes when TEST_ROUTES=1; test/session.test.ts pins BOTH modes.)
    const cookies = await page.context().cookies();
    expect(
      cookies.find((c) => c.name === "tj_session"),
      "the browser did not store the tj_session cookie — check the cookie's Domain/Secure attributes for dev",
    ).toBeDefined();

    // ---- 2. Read the token the api "emailed" --------------------------------
    const token = await readVerificationToken(request);

    // ---- 3. Verify, CARRYING THE SIGNUP SESSION -----------------------------
    // ⚠️ Same browser context, so the session cookie rides along — that is the
    // whole point. `GET /verify-email` REQUIRES a live, non-stale session
    // belonging to the token's own user (it closes an account-takeover chain:
    // holding the link is not proof of holding the password). With no session it
    // answers 401 LOGIN_REQUIRED and the page renders #login-required instead.
    await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);

    await expect(
      page.locator("#verified"),
      "verification failed — the signup session was probably not carried to /verify-email",
    ).toBeVisible();

    // ---- 4. THE PAYOFF: posting now succeeds --------------------------------
    // Identical to the negative case below in every respect except that this
    // user verified. The soft gate is the only difference between them.
    await page.goto("/new-post");
    await page.fill('input[name="title"]', "My first post");
    await page.fill('textarea[name="body"]', "Written by a verified account.");
    await page.click('button[type="submit"]');

    await expect(
      page.locator("#created"),
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
   * ambiguous.
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
    await page.fill('input[name="title"]', "Too early");
    await page.fill('textarea[name="body"]', "This account never verified.");
    await page.click('button[type="submit"]');

    await expect(
      page.locator("#unverified"),
      "an UNVERIFIED user was not stopped by the soft gate",
    ).toBeVisible();
    // The post must NOT have been created.
    await expect(page.locator("#created")).toHaveCount(0);

    // ⚠️ Distinguishes the SOFT GATE (403 EMAIL_NOT_VERIFIED) from the other
    // ways this page can fail. #unverified is only rendered after the request
    // cleared origin + session + CSRF + epoch and was stopped by the gate
    // itself; a CSRF/origin 403 renders #error and a dead session renders
    // #session-expired. Without this, a broken CSRF token could masquerade as a
    // working gate.
    await expect(page.locator("#error")).toHaveCount(0);
    await expect(page.locator("#session-expired")).toHaveCount(0);
  });
});
