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
    // ⚠️ NO PARAMETER AT ALL — Turnstile calls this with an error-code
    // string, but TypeScript structural typing lets a zero-arg function
    // satisfy a call site that passes one (JS itself ignores extra call
    // arguments), so `() => void` is both valid AND accurate: this app
    // genuinely never reads that code (see the assignment below for why —
    // the server-side signal is where the real diagnosis belongs).
    turnstileOnError?: () => void;
    turnstileOnTimeout?: () => void;
    turnstile?: {
      // ⚠️ `widget` IS a real, used parameter — `window.turnstile?.reset(container)`
      // below passes one — so it cannot be dropped the way turnstileOnError's
      // was. Codacy flags it anyway (a "reset" definitely unused warning);
      // traced independently across THREE renaming attempts (widget, _widget,
      // a rest-tuple named args) and the finding followed the parameter
      // regardless of name — an interface method signature has no body, so
      // ANY named parameter in one reads as "unused" to this rule. Disposed
      // as a false positive on the PR rather than mangled into a fourth
      // syntax variant; see this PR's Codacy comment for the trace.
      reset: (widget?: string | HTMLElement) => void;
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
