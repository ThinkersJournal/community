/**
 * THE REALTIME SPINE — the WS-delivered sibling of ./notifications.spec.ts.
 * That spec proves the POLL path (M2.3a): A must navigate/reload to pick up a
 * new count. THIS spec proves the PUSH path (M2.3b): with A's tab doing
 * NOTHING — no goto, no reload, no visibility change — between B's action and
 * the badge updating, across both Workers + real Postgres + the per-user
 * NotifyDO, under the same `wrangler dev` topology Task 0 proved.
 *
 * ⚠️ THE ISOLATION ARGUMENT (why a fast badge update proves the WS, not the
 * poll). `notify-bell.ts` refreshes the count on exactly four occasions: (1)
 * initial page load, (2) `visibilitychange` back to `"visible"`, (3) a 60s
 * `setInterval`, and (4) a pushed WS message. Once a tab is loaded, focused,
 * and left alone, (1) and (2) cannot fire again — there is no navigation and
 * no visibility transition — and (3) cannot fire inside an 8s window because
 * 8s << 60s. That leaves exactly one path that CAN update the badge that
 * quickly: the WS push. So `expect(...).toHaveText("1", { timeout: 8000 })`
 * / `.toBeHidden({ timeout: 8000 })` below, with the tab under test untouched
 * since its socket opened, is a discriminating assertion, not just a generous
 * timeout on the poll — and miniflare has no Workers Cache either (see
 * playwright.config.ts), so nothing here is a masked cache hit; every
 * notifications response is no-store.
 *
 * ⚠️ THE ONE RACE THAT MAKES THIS FLAKE (see Task 0's spike + the task
 * brief). The nudge is CONTENT-FREE and the DO does NOT replay it: if a
 * recipient's socket is not open at the moment the pusher's action fires, the
 * recipient simply never gets that nudge — the next delivery is the 60s poll,
 * which the ≤8s assertions below cannot see. `notify-bell.ts` only opens its
 * socket AFTER its first successful `/api/notifications-count` (the
 * signed-in signal), so "the bell is visible" alone does NOT guarantee the
 * socket exists yet — there is a further tick between the count-200 and the
 * `new WebSocket(...)` call. `page.waitForEvent("websocket")` fires the
 * moment the browser CREATES the socket (i.e. right after that call), so
 * arming it before navigation and awaiting it after the bell is confirmed
 * visible closes the race completely before we ever let the other actor act.
 *
 * Never asserts on WS frame contents: the frames are content-free by design
 * ({type:"notification"|"read"}, see NotifyDO) — this only ever asserts the
 * OBSERVABLE badge text/visibility, never a `page.evaluate`d wire payload.
 */
import { expect, test } from "@playwright/test";

import { chooseUsername, publishPost, signUpAndVerify, uniqueHandle } from "./helpers";

test("comment → recipient's bell updates live via WebSocket (no navigation); mark-read syncs live to a second tab", async ({
  page: a,
  browser,
}) => {
  // ---- A publishes, then arms its socket BEFORE B can act ------------------
  await signUpAndVerify(a, a.request);
  const { url } = await publishPost(a, {
    title: "Notify Me Live",
    markdownSource: "body",
  });

  // ⚠️ Arm the waiter BEFORE navigating: waitForEvent registers a listener
  // that must be in place before the socket is created, not a poll after the
  // fact.
  const aWsOpened = a.waitForEvent("websocket");
  await a.goto("/feed");
  await expect(a.locator("[data-notify-bell]")).toBeVisible(); // signed-in → count-200 → island connects
  await aWsOpened; // A's socket now exists — safe for B to act

  const bCtx = await browser.newContext();
  try {
    // ---- B comments on A's post -----------------------------------------
    const b = await bCtx.newPage();
    await signUpAndVerify(b, b.request);
    await chooseUsername(b, uniqueHandle("reader"));

    await b.goto(url);
    const form = b.locator("[data-comment-form-slot] form");
    await form.locator("textarea").fill("great post, live");
    await form.locator("button[type=submit]").click();
    await expect(b.locator(".comment-body").first()).toContainText("great post, live");

    // ---- REALTIME ASSERT: A has done NOTHING since arming its socket -----
    // No goto, no reload, no visibility change on `a` since aWsOpened above.
    // See the header comment for why <8s here can only be the WS push.
    await expect(a.locator("[data-notify-badge]")).toHaveText("1", { timeout: 8000 });

    // ---- READ-SYNC: a second A tab, same session, sees the push clear it -
    const a2 = await a.context().newPage();
    const a2WsOpened = a2.waitForEvent("websocket");
    await a2.goto("/feed");
    await expect(a2.locator("[data-notify-bell]")).toBeVisible();
    await a2WsOpened;
    // a2 loads fresh (its own count-200 already reflects the comment above),
    // so this is the ordinary poll-on-load path — no timing claim here.
    await expect(a2.locator("[data-notify-badge]")).toHaveText("1");

    // A (the FIRST tab) opens its dropdown → marks everything read server-side.
    await a.locator("[data-notify-toggle]").click();
    await expect(a.locator("[data-notify-panel]")).toContainText("commented");
    await expect(a.locator("[data-notify-badge]")).toBeHidden();

    // ---- REALTIME ASSERT #2: a2 has done NOTHING since it loaded ---------
    // No goto, no reload, no visibility change, no click on a2 — only the
    // "read" push (NotifyDO's `push("read")`, wired in mark-read) can clear
    // its badge this fast.
    await expect(a2.locator("[data-notify-badge]")).toBeHidden({ timeout: 8000 });
  } finally {
    await bCtx.close();
    // a2 lives inside `a`'s context/test fixture and closes with the runner.
  }
});
