import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { applyDeviceCookie, deviceCookieOnly } from "../src/lib/device-cookie-forward";

/**
 * Final review C-1 (security-alerting spec §4.1): login, signup and reset must
 * forward the browser's device cookie to the api, or every sign-in is a "new
 * browser". ONLY that cookie: never the session or anything else the browser
 * holds (signup is how a session first comes to exist, and login and reset are
 * not tested with a carried session).
 */
const T = "A".repeat(43);
const U = "b_-".repeat(15).slice(0, 43);

describe("deviceCookieOnly", () => {
  it("keeps only the device pair, dropping the session and every other cookie", () => {
    expect(deviceCookieOnly(`tj_session=abc; __Host-tj_device=${T}; theme=dark`)).toBe(`__Host-tj_device=${T}`);
  });

  it("forwards the dev/CI name the same way", () => {
    expect(deviceCookieOnly(`tj_session_dev=s; tj_device_dev=${U}`)).toBe(`tj_device_dev=${U}`);
  });

  it.each([
    ["no Cookie header", null],
    ["no device cookie", "tj_session=abc; theme=dark"],
    ["a malformed token (42 chars)", `__Host-tj_device=${T.slice(1)}`],
    ["a lookalike name", `x__Host-tj_device=${T}`],
    ["an empty header", ""],
  ])("%s → nothing", (_why, header) => {
    expect(deviceCookieOnly(header)).toBeNull();
  });
});

describe("apiFetch's deviceCookieFrom option (applyDeviceCookie)", () => {
  const browser = (cookie: string) => new Request("https://x.test/login", { headers: { Cookie: cookie } });

  it("sets ONLY the device pair from the browser's whole Cookie header", () => {
    const h = new Headers();
    applyDeviceCookie(h, browser(`tj_session=abc; __Host-tj_device=${T}; theme=dark`));
    expect(h.get("Cookie")).toBe(`__Host-tj_device=${T}`);
  });

  it("sets nothing without the option, or when the browser holds no device cookie", () => {
    const none = new Headers();
    applyDeviceCookie(none, undefined);
    applyDeviceCookie(none, browser("tj_session=abc"));
    expect(none.has("Cookie")).toBe(false);
  });

  it("leaves a Cookie already set (`request` forwarded whole) alone", () => {
    const h = new Headers({ Cookie: "tj_session=abc" });
    applyDeviceCookie(h, browser(`__Host-tj_device=${T}`));
    expect(h.get("Cookie")).toBe("tj_session=abc");
  });

  it("apiFetch applies it from the option", () => {
    const api = readFileSync(join(import.meta.dirname, "../src/lib/api.ts"), "utf8");
    expect(api).toContain("applyDeviceCookie(headers, deviceCookieFrom);");
  });
});

describe("every web page that calls /auth/login, /auth/signup or /auth/reset-password forwards the device cookie", () => {
  // Enumerated from the INDEX (`git ls-files`), never by walking the disk (portfolio CLAUDE.md §5b).
  const ROOT = join(import.meta.dirname, "../../..");
  const AUTH_PATH = /"\/auth\/(?:login|signup|reset-password)"/;
  const pages = execFileSync("git", ["ls-files", "apps/web/src/pages"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".astro") || f.endsWith(".ts"))
    .map((f) => join(ROOT, f))
    .filter((file) => {
      const code = readFileSync(file, "utf8");
      return code.includes("apiFetch") && AUTH_PATH.test(code);
    });

  it("finds the three auth pages (positive control)", () => {
    expect(pages.map((p) => basename(p)).sort()).toEqual(["login.astro", "reset-password.astro", "signup.astro"]);
  });

  it.each(pages)("%s passes deviceCookieFrom: Astro.request", (file) => {
    expect(readFileSync(file, "utf8")).toContain("deviceCookieFrom: Astro.request");
  });
});
