// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `/admin/notices` (notice outbox PR 3) — same source-order pins as
 * admin-queue-page.test.ts: no notice content reaches the HTML on a request
 * without a verified Access JWT, and the page shows a subject and a handle only.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const PAGE = join(import.meta.dirname, "..", "src", "pages", "admin", "notices.astro");
const source = stripComments(readFileSync(PAGE, "utf8"));

describe("/admin/notices", () => {
  it("returns 401 on a missing Access JWT, and that guard precedes markPrivate, the CSP and every api call", () => {
    expect(source).toContain("Astro.request.headers.get(ACCESS_JWT_HEADER)");
    expect(source).toMatch(/accessJwt === null \|\| accessJwt === ""/);
    const guardAt = source.indexOf("if (accessJwt === null");
    const markPrivateAt = source.indexOf("markPrivate(Astro)");
    const cspAt = source.indexOf("setPublicPageCsp(Astro)");
    const listAt = source.indexOf('"/admin/notices/undelivered"');
    const resendAt = source.indexOf("/resend`");
    for (const [name, at] of Object.entries({ guardAt, markPrivateAt, cspAt, listAt, resendAt })) {
      expect(at, name).toBeGreaterThan(-1);
    }
    expect(guardAt).toBeLessThan(markPrivateAt);
    expect(guardAt).toBeLessThan(cspAt);
    expect(guardAt).toBeLessThan(listAt);
    expect(guardAt).toBeLessThan(resendAt);
  });

  it("validates the notice id as a UUID before it joins the api path", () => {
    expect(source).toMatch(/UUID_RE\.test\(noticeId\)/);
    expect(source.indexOf("UUID_RE.test(noticeId)")).toBeLessThan(source.indexOf("/resend`"));
  });

  it("shows the subject and handle, never a body or an address; offers Resend only when resendable", () => {
    expect(source).toContain("n.subject");
    expect(source).toContain("n.recipientHandle");
    expect(source).not.toMatch(/bodyText|bodyHtml|body_text|body_html|recipientEmail|recipient_email/);
    expect(source).toMatch(/n\.resendable\s*\?/);
  });

  it("is linked from the moderation queue", () => {
    const queue = readFileSync(join(import.meta.dirname, "..", "src", "pages", "admin", "queue.astro"), "utf8");
    expect(queue).toContain('href="/admin/notices"');
  });
});
