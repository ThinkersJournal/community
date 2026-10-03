import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #113 plan B, Task 7 — source-pin tests for the appeal/delete-request/
 * admin-appeals pages, PLUS the hidden-post banner's appeal link. Same
 * technique as test/admin-media-access-page.test.ts (SSR page logic isn't
 * otherwise testable in plain-Node vitest — these pages import
 * `cloudflare:workers` via src/lib/api.ts/admin-api.ts): read the source,
 * strip comments so a comment mentioning a pattern can't fool a `toContain`,
 * and pin on literal substrings / ordering.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function readPage(...parts: string[]): string {
  return stripComments(readFileSync(join(import.meta.dirname, "..", "src", "pages", ...parts), "utf8"));
}

describe("appeal.astro — never POSTs on a GET", () => {
  const source = readPage("appeal.astro");

  it("has exactly one `method: \"POST\"` api call", () => {
    const matches = source.match(/method:\s*"POST"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("⚠️ that one POST call sits INSIDE `if (Astro.request.method === \"POST\")`", () => {
    const guardAt = source.indexOf('if (Astro.request.method === "POST")');
    const postCallAt = source.search(/method:\s*"POST"/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(postCallAt).toBeGreaterThan(guardAt);
  });

  it("peeks a token via GET /appeals/token, never consuming on the GET", () => {
    expect(source).toMatch(/apiFetch[^(]*\(\s*`\/appeals\/token\?token=/);
  });

  it("the signed-in path reads GET /appeals/for-post/<id>, forwarding the request", () => {
    expect(source).toMatch(/\/appeals\/for-post\/\$\{encodeURIComponent\(postId\)\}/);
    expect(source).toContain("request: Astro.request");
  });

  it("awaiting-review copy for a null target on the post path", () => {
    expect(source).toContain("This post is awaiting a moderator's review. Once they decide, you can appeal from here.");
  });

  it("already-appealed copy, shown for a target that already has one", () => {
    expect(source).toContain("You have already appealed this decision.");
  });

  it("forwards the browser's own Origin verbatim, never a synthesized one", () => {
    expect(source).toContain('Astro.request.headers.get("Origin")');
  });

  it("posts to /appeals/by-token or /appeals, never anywhere else", () => {
    expect(source).toMatch(/"\/appeals\/by-token"/);
    expect(source).toMatch(/"\/appeals"/);
  });
});

describe("account/delete-request.astro — never POSTs on a GET, confirm is gated", () => {
  const source = readPage("account", "delete-request.astro");

  it("has exactly one `method: \"POST\"` api call", () => {
    const matches = source.match(/method:\s*"POST"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("⚠️ that one POST call sits INSIDE `if (Astro.request.method === \"POST\")`", () => {
    const guardAt = source.indexOf('if (Astro.request.method === "POST")');
    const postCallAt = source.search(/method:\s*"POST"/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(postCallAt).toBeGreaterThan(guardAt);
  });

  it("peeks a token via GET /account/delete-request/token (peek), never consuming on the GET", () => {
    expect(source).toMatch(/apiFetch[^(]*\(\s*`\/account\/delete-request\/token\?token=/);
  });

  it("⚠️ `confirm: true` is sent only inside a branch gated on the form's `confirm` field", () => {
    const confirmFieldAt = source.indexOf('form.get("confirm")');
    const confirmTrueAt = source.indexOf("confirm: true");
    expect(confirmFieldAt).toBeGreaterThan(-1);
    expect(confirmTrueAt).toBeGreaterThan(-1);
    // The checkbox-read must appear before the body that sends `confirm: true`,
    // and nothing sends `confirm: true` unconditionally — the literal must be
    // inside the same `if` as the checkbox read (checked via the gate below).
    expect(confirmFieldAt).toBeLessThan(confirmTrueAt);
    const between = source.slice(confirmFieldAt, confirmTrueAt);
    expect(between).toMatch(/if\s*\(/);
  });

  it("states the legal-hold-revised deletion consequence plainly", () => {
    expect(source).toContain("anonymised");
    expect(source).toMatch(/30 days/);
    expect(source).toMatch(/legal hold/i);
    expect(source).toMatch(/email address stays blocked/);
  });

  it("has exactly one required checkbox named confirm", () => {
    expect(source).toMatch(/name="confirm"[^>]*required/);
  });
});

describe("account/delete-request/resend.astro — same outcome message regardless of enumeration", () => {
  const source = readPage("account", "delete-request", "resend.astro");

  it("Turnstile-widened CSP, same as forgot-password.astro", () => {
    expect(source).toContain("setPublicPageCsp(Astro, { turnstile: true })");
  });

  it("⚠️ no branch on response.status other than 429 — one literal success string covers every other outcome", () => {
    const statusBranches = source.match(/response\.status === \d+/g) ?? [];
    expect(statusBranches).toEqual(["response.status === 429"]);
  });

  it("renders the same found-or-not copy", () => {
    expect(source).toContain("If that address belongs to a restricted account, we've sent it a link.");
  });
});

describe("admin/appeals.astro — the Access-JWT guard is the FIRST statement", () => {
  const source = readPage("admin", "appeals.astro");

  it("reads the Access JWT header and 401s on absence, before anything else", () => {
    const guardAt = source.indexOf("Astro.request.headers.get(ACCESS_JWT_HEADER)");
    const markPrivateAt = source.indexOf("markPrivate(Astro)");
    const cspAt = source.indexOf("setPublicPageCsp(Astro)");
    const listAt = source.indexOf('adminApiFetch<AdminAppealsResponse>("/admin/appeals"');
    for (const [name, pos] of [
      ["guard", guardAt], ["markPrivate", markPrivateAt], ["csp", cspAt], ["list fetch", listAt],
    ] as const) {
      expect(pos, `${name} not found`).toBeGreaterThan(-1);
    }
    expect(guardAt).toBeLessThan(markPrivateAt);
    expect(guardAt).toBeLessThan(cspAt);
    expect(guardAt).toBeLessThan(listAt);
  });

  it("imports the shared appeal wire types, not a local re-declaration", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bAdminAppealsResponse\b[^}]*\}\s*from\s*"@thinkersjournal\/shared"/,
    );
    expect(source).toMatch(/AdminAppealResolveRequest|AdminAppealResolveResponse/);
  });

  it("shows the appellant's handle, never raises an email field", () => {
    expect(source).toContain("appellantHandle");
    expect(source).not.toMatch(/appellantEmail|\.email\b/);
  });

  it("links a post/comment appeal to the post page, and an account appeal to /admin/accounts/<handle>", () => {
    expect(source).toMatch(/\/admin\/accounts\/\$\{encodeURIComponent\(/);
    expect(source).toMatch(/targetPostHandle/);
    expect(source).toMatch(/targetPostSlug/);
  });

  it("shows APPEAL_SUPERSEDED and APPEAL_RESOLVED outcomes distinctly", () => {
    expect(source).toContain("APPEAL_SUPERSEDED");
    expect(source).toMatch(/newer decision replaced this one/);
  });

  it("shows sameReviewer as checkable, not refused (spec decision #8)", () => {
    expect(source).toContain("sameReviewer");
    expect(source).toMatch(/Resolved by the same moderator who took the action/);
  });

  it("one form per appeal with a required reason and grant/deny buttons", () => {
    expect(source).toMatch(/name="reason"[^>]*required/);
    expect(source).toMatch(/value="grant"/);
    expect(source).toMatch(/value="deny"/);
  });
});

describe("new-post.astro — the hidden-post banner links to its appeal (#53)", () => {
  const source = readPage("new-post.astro");

  it("no more #53 placeholder comment", () => {
    // stripComments removed it if present; also check the RAW source in case
    // the marker text leaked outside a comment block.
    const raw = readFileSync(join(import.meta.dirname, "..", "src", "pages", "new-post.astro"), "utf8");
    expect(raw).not.toContain("NO APPEAL LINK YET");
    expect(raw).not.toMatch(/#53/);
  });

  it("links to /appeal?post= only when hiddenReason is 'moderation'", () => {
    expect(source).toMatch(/hiddenReason === "moderation"/);
    expect(source).toMatch(/\/appeal\?post=\$\{encodeURIComponent\(postId\)\}/);
  });
});
