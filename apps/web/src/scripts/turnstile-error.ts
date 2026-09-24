/**
 * Turnstile error/timeout UX (PM task, 2026-09-24, following the #89
 * outage-that-wasn't). Shared by signup.astro and forgot-password.astro —
 * same widget, same failure shapes, same fix.
 *
 * ⚠️ THE PROBLEM THIS CLOSES: a failed challenge left the visitor on
 * "Verifying…" FOREVER, with no feedback and no way to retry short of a
 * full page reload. That silence is what turned a working-as-designed
 * Turnstile escalation (a slow connection triggering an interactive
 * challenge) into a two-hour production investigation tonight — the
 * failure was real, the CAUSE (Turnstile) was a red herring, and the
 * thing actually missing was visible feedback.
 *
 * ⚠️ THIS DOES NOT WEAKEN THE WIDGET IN ANY WAY, AND MUST NEVER BE CHANGED
 * TO. No mode change (Managed stays Managed), no `data-size` skip trick, no
 * client-side bypass, no auto-retry that could look like automation to
 * Cloudflare's own bot detection. The challenge escalating for a
 * lower-reputation client is Turnstile working correctly — this file only
 * makes that state visible and recoverable, never easier to route around.
 *
 * `data-error-callback` / `data-timeout-callback` are Turnstile's own
 * documented extension points — global function names the widget calls by
 * name (https://developers.cloudflare.com/turnstile/reference/client-side-rendering/).
 * They REQUIRE the callback to exist on `window` by the time Turnstile's
 * `api.js` decides to call it, which is always well after page load (an
 * error/timeout only fires once the widget has actually started), so
 * ordinary module-script execution order is sufficient — no race to guard.
 */
declare global {
  interface Window {
    // ⚠️ TWO SEPARATE GLOBAL NAMES, not one function taking a "which one"
    // argument — Turnstile calls `data-error-callback` and
    // `data-timeout-callback` as two independently-configured callbacks by
    // name; it does not pass a discriminator identifying which fired.
    //
    // ⚠️ REST-TUPLE PARAMS (`...args: [T?]`), NOT a named optional param —
    // an interface method signature has no body, so a NAMED parameter is
    // definitionally "unused" within the signature itself; Codacy flagged
    // exactly that, and an underscore prefix did NOT satisfy this project's
    // rule config for this position (confirmed by re-running with it, not
    // assumed). A rest tuple accepts the identical call shape (zero or one
    // argument of the given type) with no name to flag. `turnstileOnError`
    // still receives Turnstile's own error-code string at the call site —
    // this app just never reads it (see the doc comment on its assignment
    // below for why); `reset` is genuinely CALLED with a real argument
    // (`window.turnstile?.reset(container)` below), so this only changes
    // how the type is spelled, not what it accepts.
    turnstileOnError?: (...args: [string?]) => void;
    turnstileOnTimeout?: () => void;
    turnstile?: {
      reset: (...args: [(string | HTMLElement)?]) => void;
    };
  }
}

/** Fire-and-forget — a lost signal must never block or break the retry UX. */
function reportFailure(kind: "widget_error" | "widget_timeout"): void {
  void fetch("/api/turnstile-signal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  }).catch(() => { /* fire-and-forget — a lost signal must not break the UX */ });
}

export function initTurnstileErrorHandling(): void {
  const container = document.querySelector<HTMLElement>(".cf-turnstile");
  const errorNote = document.querySelector<HTMLElement>("[data-turnstile-error]");
  const retryBtn = document.querySelector<HTMLButtonElement>("[data-turnstile-retry]");
  const submitBtn = document.querySelector<HTMLButtonElement>('button[type="submit"]');
  // Only wired when the REAL widget is present — the dev/e2e dummy-token
  // fallback has no container to attach to and needs none of this.
  if (container === null || errorNote === null || retryBtn === null) return;

  const showFailure = (kind: "widget_error" | "widget_timeout"): void => {
    errorNote.hidden = false;
    if (submitBtn !== null) submitBtn.disabled = true; // no submitting on a widget that isn't ready
    reportFailure(kind);
  };

  // ⚠️ NEVER logs `errorCode` anywhere client-side beyond this — it is a
  // Turnstile-internal diagnostic code, not a credential, but this file's
  // job is the UX + a COUNT, not a diagnosis; the server-side signal above
  // already carries everything an operator needs.
  window.turnstileOnError = () => { showFailure("widget_error"); };
  window.turnstileOnTimeout = () => { showFailure("widget_timeout"); };

  retryBtn.addEventListener("click", () => {
    errorNote.hidden = true;
    if (submitBtn !== null) submitBtn.disabled = false;
    // ⚠️ `turnstile.reset(container)`, NOT a full page reload — Turnstile's
    // own documented recovery path, re-issuing the SAME widget rather than
    // re-fetching the whole page. `window.turnstile` is only defined once
    // api.js has loaded, which it always has by the time an error/timeout
    // fired in the first place.
    window.turnstile?.reset(container);
  });
}
