/**
 * SHARED E2E HELPERS — the two-Worker spine, factored out of the specs.
 *
 * ⚠️ THIS IS A HELPER MODULE, NOT A SPEC. It registers no tests, so importing it
 * cannot double-register anything (the concern e2e/resend-verification.spec.ts's
 * header raises about importing a *spec* module does not apply here). The signup
 * → fetch-token → verify sequence lived inline in e2e/signup.spec.ts; it moved
 * here VERBATIM so e2e/publish.spec.ts does not own a second copy of it, and
 * signup.spec.ts now calls `signUpAndVerify` while keeping its own tail
 * assertions (the posting payoff and the unverified negative).
 *
 * ⚠️ THE BROWSER ONLY EVER VISITS :8787 (the `web` Worker). The api is touched
 * exactly ONCE, out of band, to read the verification token — standing in for
 * the email inbox we have no access to. See `readVerificationToken`. Every other
 * step drives the real browser at :8787. Do not add direct api calls: vitest
 * already covers the api, and nothing else covers this spine.
 */
import { expect } from "@playwright/test";

import { API_URL } from "../playwright.config";

import type { APIRequestContext, Page } from "@playwright/test";

/**
 * A password that satisfies the api's zod schema (>= 12 chars). The password is
 * not what any of these tests is about.
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
export function uniqueEmail(prefix: string): string {
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
 * api call in the whole E2E harness.
 */
async function readVerificationToken(request: APIRequestContext): Promise<string> {
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
export async function signUp(page: Page, email: string): Promise<void> {
  await page.goto("/signup");

  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  // A real Turnstile widget (M1) will populate this; for now it is a plain
  // input, and the api runs with Cloudflare's always-passes dummy secret, so
  // any non-empty value clears the bot check.
  await page.fill('input[name="turnstileToken"]', "dummy-turnstile-token");

  await page.click('button[type="submit"]');
}

/**
 * The full signup → fetch-token → verify spine, ending on a live VERIFIED
 * session in `page`'s context. Extracted verbatim from e2e/signup.spec.ts.
 *
 * ⚠️ RETURNS `{ email }` ONLY — NOT `{ email, username }`, a DELIBERATE deviation
 * from the task brief's stated interface, and the honest one. Signup MINTS the
 * username (apps/api/src/routes/signup.ts's `generateUsername`) as
 * `<sanitized-local-part>_<~64-bit random base36 suffix>`, so it is NOT derivable
 * from the email, and NO route surfaces it to the browser except the editor's
 * own publish redirect (`/@<username>/<slug>`). Having this helper learn it would
 * mean publishing a probe post — which would give EVERY signed-up user a
 * published post and break the draft-only / single-post-listing assertions in
 * publish.spec. So the username is discovered per-test from the publish each test
 * already performs (see `publishPost`), and this helper stays side-effect-free
 * beyond the account it creates.
 */
export async function signUpAndVerify(
  page: Page,
  request: APIRequestContext,
): Promise<{ email: string }> {
  const email = uniqueEmail("verified");

  // ---- 1. Sign up ----------------------------------------------------------
  await signUp(page, email);

  await expect(
    page.locator("#check-email"),
    "signup did not reach the 'check your email' state",
  ).toBeVisible();

  // ⚠️ THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BLOCKER. The api
  // mints the session on 201, `web` propagates the Set-Cookie, and the browser
  // must actually STORE it. The production cookie is HOST-ONLY (no `Domain=`
  // attribute, scoped to exactly `community.thinkersjournal.com`) and carries
  // `Secure` — and `Secure` alone is enough to make no browser store it on
  // http://127.0.0.1: it is silently dropped, and every step below fails with
  // a misleading "please log in". Pinned here so that failure is named at the
  // point it happens. (apps/api/src/auth/session.ts drops `Secure` in dev when
  // TEST_ROUTES=1 — `Domain` is never set in either mode; test/session.test.ts
  // pins both modes.)
  const cookies = await page.context().cookies();
  expect(
    cookies.find((c) => c.name === "tj_session"),
    "the browser did not store the tj_session cookie — check the cookie's Secure attribute for dev",
  ).toBeDefined();

  // ---- 2. Read the token the api "emailed" ---------------------------------
  const token = await readVerificationToken(request);

  // ---- 3. Verify, CARRYING THE SIGNUP SESSION ------------------------------
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

  return { email };
}

/** A valid chosen handle: lowercase, 3–30 of [a-z0-9_]. */
export function uniqueHandle(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Claim a durable @handle via the onboarding page. Assumes not-yet-onboarded. */
export async function chooseUsername(page: Page, handle: string): Promise<void> {
  await page.goto("/choose-username");
  await page.fill('input[name="username"]', handle);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/feed$/);
}

/** What `publishPost` resolves to once the post is live at its public URL. */
export interface PublishedPost {
  /** The author's chosen @handle (random-suffixed; minted by `publishPost` itself). */
  username: string;
  /** The slug the api derived from the title. */
  slug: string;
  /** The post's DB id — needed to re-open the editor at `/new-post?post=<id>`. */
  postId: string;
  /** The absolute public URL, `http://127.0.0.1:8787/@<username>/<slug>`. */
  url: string;
}

/**
 * Author a post through the real editor and PUBLISH it, returning everything the
 * public page cannot tell you: the author's username, the slug, and the post id.
 *
 * ⚠️ M2.1: publishing is gated on a CHOSEN @handle (Task 8's `USERNAME_REQUIRED`,
 * apps/api/src/routes/posts.ts). Signup still mints an internal default username,
 * but that one can never publish — so this helper claims a durable handle via
 * `chooseUsername` FIRST, and returns THAT handle, not anything scraped off the
 * signup-minted default. `chooseUsername` assumes the caller has not already
 * onboarded, so callers of `publishPost` must not have called it already.
 *
 * ⚠️ SAVES A DRAFT FIRST, THEN PUBLISHES — and that two-step is load-bearing, not
 * laziness. The post id appears NOWHERE on the public page or the profile, and
 * the publish redirect (`/@user/slug`) does not carry it either; the editor's
 * draft-save redirect (`/new-post?post=<id>&saved=1`) is the ONLY browser-visible
 * source of it. So we save a draft to learn the id, then click Publish, which
 * PATCHes that same draft to `published` (the slug is preserved across the
 * PATCH — apps/api/src/routes/posts.ts's UPDATE never re-slugifies). The
 * intermediate draft is invisible to every other test.
 */
export async function publishPost(
  page: Page,
  post: { title: string; markdownSource: string; tags?: string[] },
): Promise<PublishedPost> {
  // M2.1: a public post needs a chosen @handle. Claim one, then publish.
  const username = uniqueHandle("author");
  await chooseUsername(page, username);

  await page.goto("/new-post");
  await page.fill("#title", post.title);
  await page.fill("#markdownSource", post.markdownSource);
  if (post.tags?.length) await page.fill("#tags", post.tags.join(", "));

  await page.click("button[value='draft']");
  await expect(page.locator("#saved")).toBeVisible();
  const postId = new URL(page.url()).searchParams.get("post");
  expect(postId, "draft save did not surface ?post=<id>").not.toBeNull();

  await page.click("button[value='publish']");
  await page.waitForURL(/\/@[^/]+\/[^/]+$/);

  const slug = new URL(page.url()).pathname.split("/")[2]!;
  return { username, slug, postId: postId!, url: page.url() };
}

/**
 * Drive the profile Follow/Unfollow toggle until the viewer is in the state
 * `expected` names ("Unfollow" = now following, "Follow" = now not following),
 * robust to TWO E2E-only hazards. Keys off the island's `data-following` marker,
 * NOT the button text.
 *
 * ⚠️ HAZARD 1 — reading the button before it hydrates. The button ships `hidden`
 * and the social island (src/scripts/social.ts) reveals it and stamps
 * `data-following` ("true"/"false") once `/api/social` returns. But the theme
 * CSS overrides the `hidden` attribute, so the UN-hydrated SSR button — text
 * "Follow", NO `data-following` — is already visible; a plain `toBeVisible()` +
 * text read races hydration and can misread that stale "Follow" (which is also
 * ambiguous: the island renders "Follow" both when NOT following AND when
 * logged-out). `data-following` is absent in SSR and unambiguous once set, so we
 * wait for it and switch on it.
 *
 * ⚠️ HAZARD 2 — a dropped `/api/follow` RESPONSE. This whole suite runs against
 * ONE long-lived `wrangler dev` process, and the M2.3b realtime bell opens a
 * WebSocket on EVERY authenticated page; across a full run those sockets
 * accumulate in the single miniflare process and it intermittently fails to
 * deliver the `/api/follow` response back to the browser — the server still
 * COMMITS (dev log shows `POST /api/follow 201`), but the island's
 * `await fetch(...)` never resolves, so it never flips the button and leaves it
 * `disabled`. This is a DEV-HARNESS artifact (production = isolated invocations
 * + hibernating DOs, no accumulation), NOT a bug in the follow/bell/social code.
 * A longer timeout does not help (the response is lost, not slow) — a reload
 * resyncs the button from the already-committed server state, which is exactly
 * what a real user whose click looked stuck would do.
 */
export async function toggleFollowTo(page: Page, expected: "Follow" | "Unfollow"): Promise<void> {
  const btn = page.locator("[data-follow-btn]");
  const want = expected === "Unfollow" ? "true" : "false"; // data-following after the toggle
  await expect(async () => {
    // 1) Ensure the island has hydrated the button (data-following present). If
    //    it hasn't — not yet run, or the /api/social fetch was dropped — reload.
    if ((await btn.getAttribute("data-following")) === null) {
      await page.reload();
    }
    await expect(btn).toHaveAttribute("data-following", /^(true|false)$/, { timeout: 8000 });
    // 2) Already in the wanted follow state?
    if ((await btn.getAttribute("data-following")) === want) return;
    // 3) Toggle. If a prior click's response was lost the button is stuck
    //    `disabled` — reload to resync from committed server state instead of
    //    clicking (a disabled button can't be clicked, and the follow may
    //    already have committed).
    if (await btn.isEnabled()) await btn.click();
    else await page.reload();
    await expect(btn).toHaveAttribute("data-following", want, { timeout: 6000 });
  }).toPass({ timeout: 30_000 });
}
