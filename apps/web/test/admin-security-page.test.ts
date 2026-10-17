import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isExpiredCursor, parseHeldClass, parseRef } from "../src/lib/admin-security";

/**
 * `/admin/security` (security-alerting spec §2.6 N6, F2): the
 * structural tests its siblings have (test/admin-media-access-page.test.ts).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const source = stripComments(
  readFileSync(join(import.meta.dirname, "..", "src", "pages", "admin", "security.astro"), "utf8"),
);

describe("/admin/security — the JWT-absent guard is the FIRST statement", () => {
  it("positive: reads the Access JWT header and returns 401 on absence", () => {
    expect(source).toContain("Astro.request.headers.get(ACCESS_JWT_HEADER)");
    expect(source).toMatch(/accessJwt === null \|\| accessJwt === ""/);
    expect(source).toMatch(/return new Response\(null, \{ status: 401 \}\);/);
  });

  it("the guard comes before markPrivate, the CSP and both api calls", () => {
    const guardAt = source.indexOf("if (accessJwt === null");
    expect(guardAt).toBeGreaterThan(0);
    for (const later of ["markPrivate(Astro)", "setPublicPageCsp(Astro)", "/admin/security/account-ref/", "/admin/security/held?"]) {
      const at = source.indexOf(later);
      expect(at, later).toBeGreaterThan(guardAt);
    }
  });

  it("is never edge-cacheable, and calls adminApiFetch directly (no generic admin proxy)", () => {
    expect(source).not.toContain("markPublicCacheable");
    expect(source).not.toContain("markFeedCacheable");
    expect(source).toContain("adminApiFetch<AdminSecurityRefResponse>(");
    expect(source).toContain("adminApiFetch<AdminSecurityHeldResponse>(");
  });

  it("tells the admin that a lookup is recorded (R4)", () => {
    expect(source).toContain("Every lookup is recorded in the moderation log");
  });

  it("escapes everything: no set:html, and the api is only given a validated ref and class", () => {
    expect(source).not.toContain("set:html");
    expect(source).toContain("parseHeldClass(params.get(\"class\"))");
    expect(source).toContain("isExpiredCursor(");
  });

  it("an expired cursor gets a clear message and a link to the class's first page, not a generic failure", () => {
    expect(source).toContain("This page's cursor has expired");
    expect(source).toContain("href={`?class=${signalClass}`}");
    expect(source).toMatch(/if \(held === null && !cursorExpired\) heldError/);
    expect(source).toContain('heldError = "UNKNOWN_CLASS"');
  });
});

describe("parseRef", () => {
  it.each([
    ["0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"],
    ["  0123456789ABCDEF0123456789ABCDEF ", "0123456789abcdef0123456789abcdef"],
    ["0123", null],
    ["../../admin/whoami", null],
    [null, null],
  ])("%j → %j", (input, want) => expect(parseRef(input)).toBe(want));
});

describe("parseHeldClass — only the classes the api holds rows for reach the api", () => {
  it.each([
    [null, "account"],
    ["", "account"],
    ["account", "account"],
    ["stuffing", "stuffing"],
    ["ip_burst", "ip_burst"],
    ["infra", "infra"],
  ])("%j → %j", (input, want) => expect(parseHeldClass(input)).toBe(want));

  it.each([
    ["purge"], // a summary class: holds nothing, the api answers 400
    ["storm"],
    ["ACCOUNT"],
    ["account&after=x"],
    ["__proto__"],
    ["constructor"],
    ["../x"],
  ])("%j → null (not forwarded)", (input) => expect(parseHeldClass(input)).toBeNull());
});

describe("isExpiredCursor — a 400 INVALID_INPUT naming only `after`", () => {
  const body = (fields: string[] | undefined) => ({ code: "INVALID_INPUT", ...(fields && { fields }) });

  it("positive: 400 + INVALID_INPUT + fields ['after']", () => {
    expect(isExpiredCursor({ status: 400, data: body(["after"]) })).toBe(true);
  });

  it.each([
    ["a bad class too", { status: 400, data: body(["class", "after"]) }],
    ["no fields", { status: 400, data: body(undefined) }],
    ["another code", { status: 400, data: { code: "NOT_FOUND", fields: ["after"] } }],
    ["a 500", { status: 500, data: body(["after"]) }],
    ["a 200", { status: 200, data: body(["after"]) }],
    ["no body", { status: 400, data: null }],
  ])("negative: %s", (_name, resp) => expect(isExpiredCursor(resp)).toBe(false));
});
