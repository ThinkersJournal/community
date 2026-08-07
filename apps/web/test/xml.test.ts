import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";

import { buildRssXml, buildSitemapXml, escapeXml, FEED_TITLE } from "../src/lib/xml";

import type { RecentPost } from "@thinkersjournal/shared";

/**
 * THE XML WELL-FORMEDNESS SUITE for sitemap.xml + rss.xml.
 *
 * ⚠️ WHY A REAL PARSER, NOT A REGEX. A feed reader rejects the WHOLE document on
 * ONE malformed item — a regex check ("does the output contain `&lt;`?") cannot
 * tell a well-formed document from one that merely LOOKS escaped in the one spot
 * it happened to check. `fast-xml-parser`'s `XMLValidator.validate()` runs a real
 * XML 1.0 parse and reports the exact defect if there is one; `XMLParser` is used
 * below to ROUND-TRIP dangerous input back out and prove the decoded value is
 * byte-for-byte the original raw string — the strongest statement this suite can
 * make: not just "no `<` survived," but "the reader that decodes this document
 * sees exactly what the author typed, nothing more, nothing less."
 *
 * ⚠️ MEASURED, NOT ASSUMED: `XMLValidator.validate()` does NOT enforce XML 1.0's
 * `Char` production. `XMLValidator.validate("<a>" + String.fromCharCode(1) +
 * "</a>")` returns `true` — this parser is lenient about a raw control byte that
 * a strict/spec-compliant reader is entitled to reject. It DOES correctly reject
 * unescaped `&`/`<` and mismatched tags (verified the same way), which is the
 * tag-injection hazard `escapeXml` exists for. So this suite's control-character
 * proof does not lean on the validator at all: it asserts DIRECTLY that the
 * illegal byte is absent from the string (`.not.toContain`), which is a strictly
 * stronger and spec-correct claim regardless of what any one parser tolerates.
 *

 * Building characters from `String.fromCharCode` throughout (never a `\uXXXX`
 * literal) is deliberate, not decoration — see src/lib/xml.ts's header for why.
 */

const ctrl = (codePoint: number): string => String.fromCharCode(codePoint);

function samplePost(overrides: Partial<RecentPost> = {}): RecentPost {
  return {
    id: "00000000-0000-7000-8000-000000000000",
    title: "An Ordinary Title",
    slug: "an-ordinary-title",
    username: "alice",
    excerptSource: "Some ordinary excerpt text.",
    publishedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    tags: [],
    ...overrides,
  };
}

describe("escapeXml", () => {
  it("escapes every XML metacharacter", () => {
    expect(escapeXml(`<a href="x" & 'y'>`)).toBe("&lt;a href=&quot;x&quot; &amp; &apos;y&apos;&gt;");
  });

  it("escapes & FIRST so nothing is double-escaped", () => {
    // `&lt;` -> `&amp;lt;`, never `&amp;amp;lt;`. Same trap as
    // apps/api/src/auth/email-verify.ts's escapeHtml.
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
  });

  it("⚠️ makes a title unable to break out of a feed element", () => {
    // A post titled `</title><script>…` would otherwise close the element and
    // inject markup into a document some readers render as HTML. The title never
    // goes through packages/markdown, so this function is the only guard.
    expect(escapeXml("</title><script>alert(1)</script>")).not.toContain("<");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeXml("Hello, world — 2026")).toBe("Hello, world — 2026");
  });

  it("⚠️ strips XML-illegal C0 control characters outright (no valid escape exists for them)", () => {
    // U+0001 (SOH), U+0007 (BEL), U+001F — all outside XML 1.0's Char production.
    const raw = `a${ctrl(0x01)}b${ctrl(0x07)}c${ctrl(0x1f)}d`;
    // Anti-vacuity: prove the input actually carries them before asserting they're gone.
    expect(raw).toContain(ctrl(0x01));
    expect(escapeXml(raw)).toBe("abcd");
  });

  it("preserves the three control characters XML 1.0 explicitly allows (TAB, LF, CR)", () => {
    const raw = `a${ctrl(0x09)}b${ctrl(0x0a)}c${ctrl(0x0d)}d`;
    expect(escapeXml(raw)).toBe(raw);
  });

  it("⚠️ replaces an unpaired (lone) UTF-16 surrogate with U+FFFD", () => {
    // A lone high surrogate — the title never passes through markdownExcerpt's
    // code-point-safe truncation, so this function is the only net for it.
    const raw = `a${ctrl(0xd800)}b`;
    const escaped = escapeXml(raw);
    expect(escaped).not.toContain(ctrl(0xd800));
    expect(escaped).toBe(`a${ctrl(0xfffd)}b`);
  });

  it("leaves a genuine surrogate PAIR (an emoji) untouched", () => {
    const withEmoji = "a🙂b";
    expect(escapeXml(withEmoji)).toBe(withEmoji);
  });

  it("never produces a literal `]]>` — a title containing it stays broken up by escaping", () => {
    // Only load-bearing for CDATA sections, which this module never emits — but
    // pinned because it costs nothing and closes the question for good.
    const raw = "Season 1]]>Season 2";
    const escaped = escapeXml(raw);
    expect(escaped).not.toContain("]]>");
    expect(escaped).toBe("Season 1]]&gt;Season 2");
  });
});

describe("buildSitemapXml — well-formedness", () => {
  it("is valid XML with zero posts", () => {
    const xml = buildSitemapXml([]);
    expect(XMLValidator.validate(xml)).toBe(true);
  });

  it("lists the homepage, one <url> per unique author, and one per post", () => {
    const posts = [
      samplePost({ id: "1", username: "alice", slug: "one" }),
      samplePost({ id: "2", username: "alice", slug: "two" }),
      samplePost({ id: "3", username: "bob", slug: "three" }),
    ];
    const xml = buildSitemapXml(posts);
    expect(XMLValidator.validate(xml)).toBe(true);

    const parser = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === "url" });
    const parsed = parser.parse(xml) as {
      urlset: { url: { loc: string; lastmod?: string }[] };
    };
    const locs = parsed.urlset.url.map((u) => u.loc);
    // homepage + 2 unique authors (alice, bob) + 3 posts = 6
    expect(locs).toHaveLength(6);
    expect(locs).toContain("https://community.thinkersjournal.com/");
    expect(locs).toContain("https://community.thinkersjournal.com/@alice");
    expect(locs).toContain("https://community.thinkersjournal.com/@bob");
    expect(locs).toContain("https://community.thinkersjournal.com/@alice/one");
    expect(locs).toContain("https://community.thinkersjournal.com/@bob/three");
  });

  it("⚠️ stays well-formed when a username survives URL-encoding with an apostrophe intact", () => {
    // `encodeURIComponent` (postUrl/profileUrl) deliberately leaves `'` alone —
    // it is not a reserved character to the WHATWG URL algorithm — so escapeXml
    // is the only thing standing between that apostrophe and the document.
    const hostile = "o'brien";
    expect(encodeURIComponent(hostile)).toContain("'"); // anti-vacuity: prove it survives encoding
    const posts = [samplePost({ username: hostile, slug: "x" })];
    const xml = buildSitemapXml(posts);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain("&apos;");
    // `escapeXml` spells an apostrophe out as the 6-character `&apos;` entity —
    // there is no bare `'` byte left anywhere in well-formed output to find.
    expect(xml).not.toContain("'");

    const parser = new XMLParser({ isArray: (name) => name === "url" });
    const parsed = parser.parse(xml) as { urlset: { url: { loc: string }[] } };
    expect(parsed.urlset.url.map((u) => u.loc)).toContain("https://community.thinkersjournal.com/@o'brien");
  });
});

describe("buildRssXml — well-formedness", () => {
  it("is valid XML with zero posts", () => {
    const xml = buildRssXml([]);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain(`<title>${FEED_TITLE}</title>`.replace("'", "&apos;"));
  });

  it("carries the channel's atom:link self-reference and one <item> per post", () => {
    const posts = [samplePost({ id: "1" }), samplePost({ id: "2" })];
    const xml = buildRssXml(posts);
    expect(XMLValidator.validate(xml)).toBe(true);

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", isArray: (name) => name === "item" });
    const parsed = parser.parse(xml) as {
      rss: {
        channel: {
          "atom:link": { "@_href": string; "@_rel": string; "@_type": string };
          item: { title: string; guid: { "#text": string; "@_isPermaLink": string } }[];
        };
      };
    };
    expect(parsed.rss.channel.item).toHaveLength(2);
    expect(parsed.rss.channel["atom:link"]["@_href"]).toBe("https://community.thinkersjournal.com/rss.xml");
    expect(parsed.rss.channel["atom:link"]["@_rel"]).toBe("self");
    // A stable, permanent identifier — the post's uuid, never the URL.
    expect(parsed.rss.channel.item[0]!.guid["@_isPermaLink"]).toBe("false");
  });

  it("⚠️ round-trips a title carrying EVERY dangerous case at once: <, &, \", ', and ]]>", () => {
    const hostileTitle = `</title><script>alert(1)</script> & "quoted" 'quoted' ]]>`;
    const posts = [samplePost({ title: hostileTitle })];
    const xml = buildRssXml(posts);

    // Anti-vacuity: the RAW xml string must actually be dangerous-looking before
    // proving escapeXml neutralized it — otherwise "not.toContain" is meaningless.
    expect(hostileTitle).toContain("<script>");

    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("]]>");

    const parser = new XMLParser({ isArray: (name) => name === "item" });
    const parsed = parser.parse(xml) as { rss: { channel: { item: { title: string }[] } } };
    // The strongest claim: a real XML parser decodes the escaped title back to
    // BYTE-FOR-BYTE the original hostile string — nothing lost, nothing extra.
    expect(parsed.rss.channel.item[0]!.title).toBe(hostileTitle);
  });

  it("⚠️ strips a control character out of the description so the feed stays well-formed", () => {
    // excerptSource is markdown; a raw control byte survives remark's parse
    // unchanged (it is not markdown syntax) and reaches escapeXml via
    // markdownExcerpt, exactly like a real paste-artifact post would.
    //
    // ⚠️ U+0001 (SOH), DELIBERATELY NOT U+000B/U+000C. Those two are also
    // matched by JS's `\s`, so markdownExcerpt's OWN `.replace(/\s+/g, " ")`
    // would collapse them before escapeXml ever saw them — a mutation to
    // escapeXml's own control-char guard would not redden this test, which is
    // exactly the vacuous-test failure mode this suite exists to avoid. U+0001
    // is not whitespace to `\s`, so it survives markdownExcerpt intact and this
    // test is really exercising escapeXml.
    const hostileExcerpt = `Some text with a stray byte${ctrl(0x01)}right here.`;
    expect(hostileExcerpt).toContain(ctrl(0x01)); // anti-vacuity
    expect(/\s/.test(ctrl(0x01))).toBe(false); // anti-vacuity: not swallowed upstream by \s
    const posts = [samplePost({ excerptSource: hostileExcerpt })];
    const xml = buildRssXml(posts);

    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).not.toContain(ctrl(0x01));

    const parser = new XMLParser({ isArray: (name) => name === "item" });
    const parsed = parser.parse(xml) as { rss: { channel: { item: { description: string }[] } } };
    expect(parsed.rss.channel.item[0]!.description).not.toContain(ctrl(0x01));
  });

  it("carries an excerpt derived from markdown, not the raw source", () => {
    // A sanity check that buildRssXml is really calling markdownExcerpt (a GFM
    // table, say) rather than dumping excerptSource's raw markdown syntax.
    const posts = [samplePost({ excerptSource: "# Heading\n\nSome **bold** text." })];
    const xml = buildRssXml(posts);
    const parser = new XMLParser({ isArray: (name) => name === "item" });
    const parsed = parser.parse(xml) as { rss: { channel: { item: { description: string }[] } } };
    expect(parsed.rss.channel.item[0]!.description).toBe("Heading Some bold text.");
  });
});
