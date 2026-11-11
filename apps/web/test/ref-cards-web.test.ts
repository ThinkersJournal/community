// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderMarkdown } from "@thinkersjournal/markdown";
import { CONTACT_EMAIL, type RefCard } from "@thinkersjournal/shared";
import { describe, expect, it, vi } from "vitest";

import Bot from "../src/pages/bot.astro";
import { cardImageOrigins, PUBLIC_PAGE_CSP, SIGNUP_PAGE_CSP, setPublicPageCsp, type CspContext } from "../src/lib/csp";
import { json, renderPage } from "./helpers/render-page";

/**
 * M3.1b on the web side: the post page's CSP allowance for hotlinked card images (spec 4.3 / 7), the call site that
 * hands the api's `refs` to the renderer, and the /bot page. The post page itself cannot be rendered here (it needs the
 * Workers runtime), so its wiring is pinned from source, as test/post-page.test.ts does.
 */
const marked: string[][] = [];
vi.mock("../src/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/cache")>()),
  markPublicCacheable: (_ctx: unknown, tags: string[]) => {
    marked.push(tags);
    return true;
  },
}));

function directive(csp: string, name: string): string {
  const found = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  if (found === undefined) throw new Error(`CSP has no ${name} directive: ${csp}`);
  return found.slice(name.length).trim();
}

const cspFor = (opts: { turnstile?: boolean; imageOrigins?: readonly string[] }): string => {
  const ctx: CspContext = { response: { headers: new Headers() } };
  setPublicPageCsp(ctx, opts);
  const header = ctx.response.headers.get("content-security-policy");
  expect(header).not.toBeNull();
  return header as string;
};

describe("CSP img-src for reference-card images: per request, exact origins only", () => {
  const card = (url: string, storage: "remote" | "stored" = "remote"): RefCard =>
    storage === "remote"
      ? { kind: "web", deepLink: "https://example.com/p", title: "T", image: { storage: "remote", url } }
      : { kind: "web", deepLink: "https://example.com/p", title: "T", image: { storage: "stored", key: "k", width: 1, height: 1 } };
  const CDN = "https://cdn.thinkersjournal.com";
  const imgSrcOf = (imageOrigins: string[]) => directive(cspFor({ imageOrigins }), "img-src");

  // Mutation that must fail: widen img-src to a bare https: (author and commenter images would load too).
  it("never emits a bare https: or a wildcard", () => {
    const imgSrc = imgSrcOf(["https://i.example.com"]);
    expect(imgSrc.split(" ")).not.toContain("https:");
    expect(imgSrc).not.toContain("*");
    expect(imgSrc).not.toContain("data:");
    expect(imgSrc).not.toContain("http:/");
  });

  it("a post without refs keeps the old policy EXACTLY", () => {
    expect(cspFor({ imageOrigins: [] })).toBe(PUBLIC_PAGE_CSP);
    expect(cspFor({})).toBe(PUBLIC_PAGE_CSP);
    expect(directive(PUBLIC_PAGE_CSP, "img-src")).toBe("'self' " + CDN);
    expect(directive(SIGNUP_PAGE_CSP, "img-src")).toBe("'self' " + CDN);
  });

  it("a post with refs gets only those origins, added to the old policy", () => {
    expect(imgSrcOf(["https://i.example.com", "https://j.example.com:8443"])).toBe(
      "'self' " + CDN + " https://i.example.com https://j.example.com:8443",
    );
  });

  // Mutation that must fail: allow an origin the cards did not name (an author or commenter markdown image).
  it("an origin that appears only in author markdown is NOT allowed", () => {
    const refs = { ABCDEFGHIJKL: card("https://i.example.com/a.png") };
    const imgSrc = imgSrcOf(cardImageOrigins(refs));
    expect(imgSrc).toContain("https://i.example.com");
    expect(imgSrc).not.toContain("tracker.example.net");
  });

  it("the post policy differs from the public one in img-src ONLY", () => {
    const rest = (csp: string) => csp.split(";").map((p) => p.trim()).filter((p) => !p.startsWith("img-src"));
    expect(rest(cspFor({ imageOrigins: ["https://i.example.com"] }))).toEqual(rest(PUBLIC_PAGE_CSP));
  });

  describe("cardImageOrigins", () => {
    it("takes the https origin of each remote card image, deduplicated, in order", () => {
      const refs = {
        AAAAAAAAAAAA: card("https://i.example.com/a.png"),
        BBBBBBBBBBBB: card("https://i.example.com/b.png?x=1"),
        CCCCCCCCCCCC: card("https://u:p@j.example.com:8443/c.png"),
      };
      expect(cardImageOrigins(refs)).toEqual(["https://i.example.com", "https://j.example.com:8443"]);
    });

    it("ignores http, javascript, data, stored images, null cards and cards with no image", () => {
      const refs: Record<string, RefCard | null> = {
        AAAAAAAAAAAA: card("http://i.example.com/a.png"),
        BBBBBBBBBBBB: card("javascript:alert(1)"),
        CCCCCCCCCCCC: card("data:image/png;base64,AAAA"),
        DDDDDDDDDDDD: card("", "stored"),
        EEEEEEEEEEEE: null,
        FFFFFFFFFFFF: { kind: "web", deepLink: "https://example.com/p", title: "T" },
        GGGGGGGGGGGG: card("not a url"),
      };
      expect(cardImageOrigins(refs)).toEqual([]);
    });

    // Mutation that must fail: build the origin from the raw string instead of URL.origin plus the shape check.
    it.each([
      "https://a.com;script-src *;/x.png",
      "https://a.com;evil.com/x.png",
      "https://a.com,evil.com/x.png",
      "https://a.com%3Bscript-src/x.png",
      "https://a.com/x.png;script-src *",
      "https://[::1]/x.png",
    ])("header injection is impossible: %s adds no directive and no separator", (url) => {
      const origins = cardImageOrigins({ AAAAAAAAAAAA: card(url) });
      for (const o of origins) expect(o).toMatch(/^https:\/\/[a-z0-9.-]+(:\d+)?$/);
      const csp = cspFor({ imageOrigins: origins });
      expect(csp.split(";").length).toBe(PUBLIC_PAGE_CSP.split(";").length);
      expect(directive(csp, "script-src")).toBe(directive(PUBLIC_PAGE_CSP, "script-src"));
    });
  });
});

describe("the post page hands the api's refs to the renderer", () => {
  const code = readFileSync(join(import.meta.dirname, "../src/pages/[handle]/[slug].astro"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  // Mutation that must fail: call renderMarkdown without refs (unknown tokens would then show as raw text).
  it("always passes a refs map, even when the post has none", () => {
    expect(code).toContain("renderMarkdown(post.markdownSource, { refs: new Map(Object.entries(post.refs ?? {})) })");
  });

  it("derives the CSP image origins from post.refs, per request", () => {
    expect(code).toContain("cardImageOrigins(post.refs ?? {})");
    expect(code).toContain("setPublicPageCsp(Astro, { imageOrigins })");
  });

  it("the api's wire type is accepted by the renderer (a compile-time pin of the two structural RefCards)", async () => {
    const card: RefCard = { kind: "web", deepLink: "https://example.com/p", title: "T", image: { storage: "remote", url: "https://i.example.com/a.png" } };
    const refs = new Map<string, RefCard | null>([["ABCDEFGHIJKL", card]]);
    const html = await renderMarkdown("{{ref:ABCDEFGHIJKL}}", { refs });
    expect(html).toContain('href="https://example.com/p"');
    expect(html).toContain('referrerpolicy="no-referrer"');
  });
});

describe("/bot", () => {
  it("renders the one paragraph, names the bot and its robots token, and is cacheable", async () => {
    const res = await renderPage(Bot, { url: "http://localhost/bot", api: () => json(500, {}) });
    expect(res.status).toBe(200);
    expect(marked.at(-1)).toEqual(["bot"]);
    const html = await res.text();
    expect(html).toContain("<h1>ThinkersJournalBot</h1>");
    expect(html).toContain("ThinkersJournalBot/1.0");
    expect(html).toContain("robots.txt");
    expect(html).toContain(CONTACT_EMAIL);
  });
});
