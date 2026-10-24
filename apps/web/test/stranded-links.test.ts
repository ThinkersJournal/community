// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Reachability-audit F1/F2/F3: three stranded-user gaps closed with links.
 * Footer + new-post links must be STATIC server-rendered markup (they exist
 * without JavaScript); the comment-island and bell links are script-built and
 * must use createElement, never innerHTML.
 */
const read = (rel: string) => readFileSync(join(import.meta.dirname, "..", rel), "utf8");

describe("Footer ships static links to /notifications and /settings (F2, F3)", () => {
  const footer = read("src/components/Footer.astro");
  // The markup region only: everything before the <style> block, frontmatter
  // stripped — so a script-built link cannot satisfy these.
  const markup = footer.replace(/^---[\s\S]*?---/, "").split("<style>")[0] ?? "";

  it("has a literal <a href=\"/notifications\"> labelled Notifications", () => {
    expect(markup).toMatch(/<a href="\/notifications">Notifications<\/a>/);
  });
  it("has a literal <a href=\"/settings\"> labelled Settings", () => {
    expect(markup).toMatch(/<a href="\/settings">Settings<\/a>/);
  });
  it("builds neither link from script", () => {
    expect(footer).not.toMatch(/<script/i);
    expect(footer).not.toContain("createElement");
  });
});

describe("new-post unverified message links to the resend form (F1)", () => {
  it("renders an SSR anchor to /verify-email inside #unverified", () => {
    const s = read("src/pages/new-post.astro");
    expect(s).toMatch(
      /<p id="unverified">[^<]*<a [^>]*href="\/verify-email"[^>]*>Resend the verification email<\/a>[\s\S]*?<\/p>/,
    );
  });
});

describe("comment island EMAIL_NOT_VERIFIED links to the resend form (F1)", () => {
  const code = read("src/scripts/comments.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("builds an anchor to /verify-email with createElement + textContent", () => {
    expect(code).toMatch(/href:\s*"\/verify-email"/);
    expect(code).toMatch(/createElement\("a"\)/);
    expect(code).toContain("Resend the verification email");
    expect(code).not.toContain("innerHTML");
  });
  it("attaches the link only on the EMAIL_NOT_VERIFIED branch", () => {
    expect(code).toMatch(/EMAIL_NOT_VERIFIED[\s\S]{0,400}\/verify-email/);
  });
});

describe("notification bell panel links to the full history page (F2)", () => {
  const code = read("src/scripts/notify-bell.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("builds a 'See all notifications' anchor to /notifications via createElement", () => {
    expect(code).toMatch(/href\s*=\s*"\/notifications"/);
    expect(code).toContain("See all notifications");
    expect(code).not.toContain("innerHTML");
  });
});
