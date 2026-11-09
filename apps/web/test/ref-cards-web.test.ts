// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderMarkdown } from "@thinkersjournal/markdown";
import { CONTACT_EMAIL, type RefCard } from "@thinkersjournal/shared";
import { describe, expect, it, vi } from "vitest";

import Bot from "../src/pages/bot.astro";
import { POST_PAGE_CSP, PUBLIC_PAGE_CSP, SIGNUP_PAGE_CSP, setPublicPageCsp, type CspContext } from "../src/lib/csp";
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

const cspFor = (opts: { turnstile?: boolean; remoteImages?: boolean }): string => {
  const ctx: CspContext = { response: { headers: new Headers() } };
  setPublicPageCsp(ctx, opts);
  const header = ctx.response.headers.get("content-security-policy");
  expect(header).not.toBeNull();
  return header as string;
};

describe("CSP img-src for reference-card images", () => {
  // Mutation that must fail: widen img-src on the shared public policy instead of the post page's opt-in.
  it("the default and signup policies keep their narrow img-src", () => {
    expect(directive(PUBLIC_PAGE_CSP, "img-src")).toBe("'self' https://cdn.thinkersjournal.com");
    expect(directive(SIGNUP_PAGE_CSP, "img-src")).toBe("'self' https://cdn.thinkersjournal.com");
    expect(cspFor({})).toBe(PUBLIC_PAGE_CSP);
  });

  // Mutation that must fail: allow http: or data: images, or remove the https: allowance (cards would be blank).
  it("the post page allows https: images and nothing broader", () => {
    const imgSrc = directive(cspFor({ remoteImages: true }), "img-src");
    expect(imgSrc).toBe("'self' https:");
    expect(imgSrc).not.toContain("http:/");
    expect(imgSrc).not.toContain("data:");
    expect(imgSrc).not.toContain("*");
  });

  it("the post policy differs from the public one in img-src ONLY", () => {
    const rest = (csp: string) => csp.split(";").map((p) => p.trim()).filter((p) => !p.startsWith("img-src"));
    expect(POST_PAGE_CSP).not.toBe(PUBLIC_PAGE_CSP);
    expect(rest(POST_PAGE_CSP)).toEqual(rest(PUBLIC_PAGE_CSP));
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

  it("opts in to remote images on the post page's CSP", () => {
    expect(code).toContain("setPublicPageCsp(Astro, { remoteImages: true })");
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
