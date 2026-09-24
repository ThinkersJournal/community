/**
 * Wires each Unblock button on /settings/blocked. This page is authed +
 * server-rendered (not cached), but the CSP on public pages forbids inline
 * script (`script-src 'self'`, no 'unsafe-inline', no nonce — see
 * src/lib/csp.ts) and this page shares that policy via setPublicPageCsp, so
 * the CSRF token travels as a data attribute, read by this BUNDLED module,
 * exactly like new-post.astro's `data-csrf-token` — not `define:vars`, which
 * would emit an inline script CSP blocks outright.
 */
export function initBlockedList(): void {
  const list = document.querySelector<HTMLElement>("[data-blocked-list]");
  if (list === null) return;
  const csrfToken = list.dataset.csrfToken ?? "";

  for (const btn of list.querySelectorAll<HTMLButtonElement>("[data-unblock-btn]")) {
    btn.addEventListener("click", () => {
      btn.disabled = true;
      const blockedId = btn.dataset.userId ?? "";
      void fetch("/api/unblock", {
        method: "POST",
        headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ blockedId }),
      })
        .then((resp) => {
          if (resp.ok) location.reload();
          else btn.disabled = false;
        })
        .catch(() => {
          btn.disabled = false;
        });
    });
  }
}
