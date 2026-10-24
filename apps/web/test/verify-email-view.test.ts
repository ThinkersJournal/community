// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { missingTokenView } from "../src/lib/verify-email-view";

const LOGIN = "/login?next=%2Fverify-email";
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("missingTokenView (no ?token=)", () => {
  it("signed in: resend-first view with plain copy, no login link", () => {
    const v = missingTokenView(true, LOGIN);
    expect(v).toEqual({
      kind: "resend-first",
      heading: "Need a new verification link?",
      note: "We will send it to the email address on your account.",
    });
  });
  it("logged out: log-in view whose link is exactly the page's next-bearing href", () => {
    const v = missingTokenView(false, LOGIN);
    expect(v).toEqual({
      kind: "log-in",
      text: "Log in to request a new verification link.",
      linkLabel: "Log in",
      href: "/login?next=%2Fverify-email",
    });
    expect(decodeURIComponent(new URL(v.kind === "log-in" ? v.href : "", "http://x").searchParams.get("next") ?? "")).toBe("/verify-email");
  });
});

describe("verify-email.astro applies the module's result", () => {
  const raw = readFileSync(join(import.meta.dirname, "../src/pages/verify-email.astro"), "utf8");
  const code = strip(raw);
  const markup = code.slice(code.indexOf("<BaseLayout"));

  it("calls missingTokenView with csrf presence and the shared loginHref", () => {
    expect(code).toMatch(/missingTokenView\(\s*csrfToken !== null,\s*loginHref\s*\)/);
  });
  it("renders the missing case from the view, not the old invalid paragraph", () => {
    expect(code).not.toContain("No verification token supplied");
    expect(markup).not.toMatch(/outcome === "missing" && <p id="invalid"/);
    expect(markup).toMatch(/missingView\?\.kind === "resend-first"/);
    expect(markup).toMatch(/missingView\?\.kind === "log-in"/);
  });
  it('keeps id="invalid" only for the real invalid-token outcome', () => {
    expect(markup.match(/id="invalid"/g)?.length).toBe(1);
    expect(markup).toMatch(/outcome === "invalid" && \(\s*<p id="invalid">/);
  });
  it("puts the form BEFORE the explanatory note in the resend-first block", () => {
    const block = markup.slice(markup.indexOf("missingView?.kind === \"resend-first\""));
    const form = block.indexOf("<form");
    const note = block.indexOf("missingView.note");
    expect(form).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(form);
    expect(block.indexOf("missingView.heading")).toBeLessThan(form);
  });
  it("does not render a second resend form for the missing outcome", () => {
    expect(code).toMatch(/csrfToken !== null && outcome !== "verified" && outcome !== "missing"/);
  });
});
