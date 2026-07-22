import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "../src/pages/api");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("/api/me", () => {
  const s = () => strip(readFileSync(join(DIR, "me.ts"), "utf8"));
  it("is a GET APIRoute, markPrivate (wrapped), proxies /profile/me + /auth/csrf, forwards cookie", () => {
    const src = s();
    expect(src).toMatch(/export const GET\s*:\s*APIRoute/);
    expect(src).toContain("export const prerender = false");
    expect(src).toMatch(/markPrivate\(/);
    expect(src).toMatch(/response:\s*\{\s*headers\s*\}/);
    expect(src).toContain("/profile/me");
    expect(src).toContain("/auth/csrf");
    expect(src).toMatch(/request:\s*context\.request/);
  });
});

describe("/api/logout", () => {
  const s = () => strip(readFileSync(join(DIR, "logout.ts"), "utf8"));
  it("is a POST APIRoute, markPrivate, proxies /auth/logout, applyCookies, forwards origin+csrf", () => {
    const src = s();
    expect(src).toMatch(/export const POST\s*:\s*APIRoute/);
    expect(src).toMatch(/markPrivate\(/);
    expect(src).toContain("/auth/logout");
    expect(src).toContain("applyCookies(");
    expect(src).toMatch(/origin/i);
    expect(src).toMatch(/X-CSRF-Token/i);
  });
});
