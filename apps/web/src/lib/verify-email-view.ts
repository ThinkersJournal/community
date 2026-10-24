// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * What /verify-email shows a visitor who arrives WITHOUT a `?token=` — the
 * "missing" outcome. Extracted from the page so it can be tested in plain Node
 * (Astro pages cannot be rendered under this repo's vitest).
 *
 * A signed-in visitor is offered the resend form FIRST; a logged-out visitor is
 * told to log in, with a link back here. `loginHref` is the page's own
 * `/login?next=<path+query>` value (built once in the page, shared with the
 * login-required outcome) — never hand-rolled here.
 */
export type MissingTokenView =
  | { kind: "resend-first"; heading: string; note: string }
  | { kind: "log-in"; text: string; linkLabel: string; href: string };

export function missingTokenView(signedIn: boolean, loginHref: string): MissingTokenView {
  if (signedIn) {
    return {
      kind: "resend-first",
      heading: "Need a new verification link?",
      note: "We will send it to the email address on your account.",
    };
  }
  return {
    kind: "log-in",
    text: "Log in to request a new verification link.",
    linkLabel: "Log in",
    href: loginHref,
  };
}
