import { describe, expect, it } from "vitest";
import { FORGOT_PASSWORD_URL, noticeHtml, noticeText, type NoticeFacts } from "../src/security/account-notice-send";

// The notice HTML must never carry an unescaped value (PM gate condition on
// #160). Strings reach the text only through `country`: the coalesced count and
// both times are numbers/Dates, so they cannot carry markup.
const HOSTILE = '<script>alert("x")</script> & co';

function facts(over: Partial<NoticeFacts>): NoticeFacts {
  return { kind: "new_sign_in", atMs: Date.UTC(2026, 9, 7, 12), country: "GB", coalesced: null, listWasEmpty: false, ...over };
}

describe("noticeHtml escapes the text it is given", () => {
  it("escapes markup, quotes and ampersands in the body", () => {
    const html = noticeHtml({ subject: "s", textBody: `before ${HOSTILE} after` });
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co");
  });

  it("still turns the forgot-password link into an anchor (control: escaping does not swallow it)", () => {
    const html = noticeHtml({ subject: "s", textBody: `Not you? ${FORGOT_PASSWORD_URL}` });
    expect(html).toContain(`<a href="${FORGOT_PASSWORD_URL}">${FORGOT_PASSWORD_URL}</a>`);
  });
});

describe("a hostile country never reaches the notice HTML", () => {
  for (const kind of ["new_sign_in", "password_reset"] as const) {
    it(`${kind}: a non-ISO country is dropped and reads as an unknown location`, () => {
      const html = noticeHtml(noticeText(facts({ kind, country: HOSTILE, coalesced: { count: 3, sinceMs: Date.UTC(2026, 9, 7, 9) } })));
      expect(html).not.toContain("<script");
      expect(html).not.toContain("alert(");
      expect(html).toContain("from an unknown location");
    });
  }
});
