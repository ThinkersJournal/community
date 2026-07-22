/**
 * Reflects the mobile nav disclosure's open/closed state to assistive tech.
 * The menu itself opens with pure CSS (checkbox-hack, zero-JS); this only
 * keeps aria-expanded on the toggle honest for screen-reader users.
 */
export function initNavToggle(): void {
  const toggle = document.querySelector<HTMLInputElement>("#nav-toggle");
  if (toggle === null) return;
  // NOT a concise `(): void => toggle.setAttribute(...)` body: worker-configuration.d.ts
  // (wrangler's ambient globals for the HTMLRewriter API) declares its own global
  // `Element` with a chainable `setAttribute(...): Element` overload that merges
  // into DOM's `Element`/`HTMLElement`, making the expression's type `Element`,
  // not `void`, and failing to typecheck as a `void`-returning arrow body (see
  // nav-auth.ts for the identical `.append()` precedent). A statement body
  // discards the return value regardless of its type.
  const sync = (): void => {
    toggle.setAttribute("aria-expanded", String(toggle.checked));
  };
  sync();
  toggle.addEventListener("change", sync);
}
