import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE EDITOR — src/pages/new-post.astro (Task 17).
 *
 * ⚠️ SOURCE/STRUCTURE TEST, NOT A RENDER — same reasoning as
 * test/post-page.test.ts and test/profile-page.test.ts. This app's vitest is
 * plain Node; the page imports `cloudflare:workers` (via src/lib/api.ts),
 * which does not resolve outside workerd. The page's RUNTIME behaviour is
 * proven on the wire under `wrangler dev` (captured in the task report) and by
 * the E2E spine (e2e/signup.spec.ts).
 *
 * What THIS file pins is the set of load-bearing invariants that are
 * otherwise enforced only by code review and are INVISIBLE to every other
 * test — most of them M0/M1 bugs that were already fixed once elsewhere in
 * this codebase and would be trivial to reintroduce here by copying the wrong
 * precedent:
 *   • the REAL browser Origin is forwarded, never synthesized (Task 18's
 *     login-CSRF incident);
 *   • `Set-Cookie` is propagated on EVERY response path, INCLUDING the 401
 *     revocation path (Task 10's resend-branch bug) AND the publish redirect
 *     (login.astro's `Astro.redirect()` bug — a response it builds itself
 *     does not carry `Astro.response.headers`);
 *   • the preview renders through the SAME `renderMarkdown` the public post
 *     page uses, never a hand-rolled/client-side renderer;
 *   • the CSRF token arrives as a hidden input, never a cookie;
 *   • the media upload goes through the same-origin proxy, never the api
 *     directly, and sends a raw body (not multipart).
 *
 * ⚠️ ANTI-VACUITY: every negative below is preceded by a POSITIVE that proves
 * we are looking at the real construct — a bare `not.toContain` over source
 * text that moved would pass while proving nothing.
 */

const PAGE = join(import.meta.dirname, "../src/pages/new-post.astro");
/**
 * ⚠️ THE MEDIA-UPLOAD ISLAND, BUNDLED OUT — the theming/CSP retrofit moved the
 * fetch/DOM logic that used to sit inline in new-post.astro's `<script>` into
 * this module (src/scripts/media-upload.ts), so new-post.astro can carry
 * `setPublicPageCsp`'s `script-src 'self'` (no `'unsafe-inline'`) without
 * blocking its own upload handler. The invariants that used to be pinned
 * against new-post.astro's raw source below now live against THIS file's
 * source instead — same technique test/social-island.test.ts uses for the
 * social island. new-post.astro itself now only needs to prove it MOUNTS the
 * island via a bundled `import` (see the theming describe block below).
 */
const ISLAND = join(import.meta.dirname, "../src/scripts/media-upload.ts");

/**
 * Strip comments so PROSE cannot satisfy an assertion — same technique as
 * test/post-page.test.ts and test/page-cache-inventory.test.ts.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const rawSource = readFileSync(PAGE, "utf8");
const code = stripComments(rawSource);
const islandRawSource = readFileSync(ISLAND, "utf8");
const islandCode = stripComments(islandRawSource);

describe("exists, and is the one page for both create and edit", () => {
  it("lives at src/pages/new-post.astro", () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it("reads `?post=` off the URL rather than having a second route for editing", () => {
    expect(code).toMatch(/searchParams\.get\(\s*["']post["']\s*\)/);
  });
});

describe("cacheability", () => {
  it("declares itself PRIVATE — never markPublicCacheable/markFeedCacheable", () => {
    // page-cache-inventory.test.ts proves this is the ONLY helper on the page;
    // this proves it is THIS one.
    expect(code).toContain("markPrivate(Astro)");
  });
});

describe("⚠️ real Origin forwarding — the Task 18 login-CSRF incident", () => {
  it("forwards the BROWSER's Origin header verbatim", () => {
    expect(code).toContain('Astro.request.headers.get("Origin")');
  });

  it("⚠️ never synthesizes its own origin for an api call", () => {
    // Positive above proves the real forward exists; this negative is
    // therefore not vacuous. `Astro.url.origin` (or `.host`) is always THIS
    // app's own origin, which is always api-allowlisted — using it here would
    // launder a cross-site request into a trusted one, exactly the bug Task
    // 18 fixed on the login page.
    expect(code).not.toMatch(/Astro\.url\.(origin|host)/);
  });

  it("passes the forwarded origin — not a fresh literal — to BOTH the create and edit api calls", () => {
    // The `origin` variable computed once from the real header must be what
    // reaches both apiFetch calls, not two independently-typed-out origins
    // (one of which could silently rot into something else).
    const occurrences = code.match(/origin,/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

describe("⚠️ Set-Cookie propagation — the Task 10 revocation-path bug, twice over", () => {
  it("applies cookies on the fallback (401 / unverified / error / defensive-success) response path", () => {
    expect(code).toContain("applyCookies(Astro.response.headers, response.setCookies)");
  });

  it("⚠️ applies cookies on BOTH redirect paths, and does NOT use Astro.redirect()", () => {
    // login.astro's header documents this exact bug: `Astro.redirect()` builds
    // a response it owns, which does not carry `Astro.response.headers`, so a
    // Set-Cookie riding on that response is silently dropped. The fix here is
    // the same one login.astro uses: build the redirect Response by hand and
    // applyCookies onto ITS headers before returning it — done for BOTH the
    // publish redirect and the draft-save redirect (below), since either can
    // carry a cookie (e.g. a session refresh).
    const redirectBuilds = code.match(/new Response\(null,\s*\{\s*status:\s*302/g) ?? [];
    expect(redirectBuilds.length).toBeGreaterThanOrEqual(2);
    const applyOnRedirect = code.match(/applyCookies\(redirect\.headers, response\.setCookies\)/g) ?? [];
    expect(applyOnRedirect.length).toBeGreaterThanOrEqual(2);
    expect(code).not.toMatch(/Astro\.redirect\(/);
  });

  it("the publish redirect Location is a RELATIVE path, not an absolute canonical URL", () => {
    // postUrl() (src/lib/canonical.ts) is a constant PRODUCTION origin — right
    // for an <link rel=canonical>, wrong for a redirect Location, which must
    // land the browser back on whichever origin actually served this request
    // (localhost in dev). A relative path does that for free.
    expect(code).toMatch(/Location:\s*`\/@\$\{response\.data\.username\}\/\$\{response\.data\.slug\}`/);
    expect(code).not.toContain("postUrl(");
  });
});

describe("⚠️ Post/Redirect/Get on a successful draft save — a gap found by hand-testing", () => {
  it("redirects to /new-post?post=<id> after a successful draft save, rather than re-rendering /new-post in place", () => {
    // A plain <form method=POST> re-renders the SAME url with no query string.
    // Without an explicit redirect, the address bar never gains `?post=`, a
    // reload re-submits the form (the browser's resubmission prompt) instead
    // of re-fetching, and there is no stable link back to this exact draft —
    // discovered by hand-testing the brief's own Step 5 checklist ("the URL
    // keeps ?post=<id> on reload").
    expect(code).toMatch(/Location:\s*`\/new-post\?post=\$\{encodeURIComponent\(response\.data\.id\)\}&saved=1`/);
  });

  it("reads the one-shot `saved=1` flag on the GET that follows to show 'Draft saved.'", () => {
    expect(code).toMatch(/searchParams\.get\(\s*["']saved["']\s*\)\s*===\s*["']1["']/);
    expect(rawSource).toContain('id="saved"');
  });
});

describe("⚠️ draft vs publish", () => {
  it("sends an explicit status, never omitting it (which would silently default to draft)", () => {
    expect(code).toMatch(/const status\s*=\s*intent === ["']publish["']\s*\?\s*["']published["']\s*:\s*["']draft["']/);
    // And that computed status actually reaches the api call's body.
    expect(code).toMatch(/body:\s*\{\s*title,\s*markdownSource,\s*status,\s*tags\s*\}/);
  });

  it("has three distinct submit intents: preview, draft, publish", () => {
    expect(rawSource).toMatch(/name="intent"\s+value="preview"/);
    expect(rawSource).toMatch(/name="intent"\s+value="draft"/);
    expect(rawSource).toMatch(/name="intent"\s+value="publish"/);
  });
});

describe("⚠️ preview — server-side, through the SAME pipeline, never a client renderer", () => {
  it("imports renderMarkdown from @thinkersjournal/markdown — the exact function the public post page uses", () => {
    expect(code).toContain('import { renderMarkdown } from "@thinkersjournal/markdown"');
    expect(code).toContain("renderMarkdown(markdownSource)");
  });

  it("⚠️ never `set:html`s anything that did NOT come out of renderMarkdown's output variable", () => {
    // Positive proved above. The only `set:html` in the whole file must bind
    // the `previewHtml` variable renderMarkdown assigned — never a raw
    // concatenation of user input, which would be exactly the self-XSS the
    // brief warns against.
    const setHtmlUses = rawSource.match(/set:html=\{[^}]*\}/g) ?? [];
    expect(setHtmlUses.length).toBeGreaterThan(0);
    for (const use of setHtmlUses) {
      expect(use).toContain("previewHtml");
    }
  });

  it("⚠️ ships NO client-side markdown parser — zero extra bundle for the preview", () => {
    // The whole point of the server-side-preview decision: no markdown/marked/
    // remark/markdown-it/commonmark import anywhere, and specifically not
    // inside the <script> island (the only code that reaches the browser).
    expect(code).not.toMatch(/\bmarked\b|\bmarkdown-it\b|\bremark\b|\bcommonmark\b/i);
  });

  it("gates preview on having a session — not reachable by a fully anonymous POST", () => {
    // A deliberate narrowing of "pure render, no mutation" into "no
    // unauthenticated free Shiki-rendering oracle" — see the frontmatter's own
    // reasoning at the preview branch.
    expect(code).toMatch(/if \(csrfToken === null\)/);
  });
});

describe("⚠️ image upload — the same-origin proxy, raw body, not multipart", () => {
  it("the island exists at src/scripts/media-upload.ts and exports initMediaUpload", () => {
    expect(existsSync(ISLAND)).toBe(true);
    expect(islandCode).toMatch(/export function initMediaUpload\(\)/);
  });

  it("uploads to /media-upload, never directly to the api", () => {
    expect(islandRawSource).toContain('fetch("/media-upload"');
  });

  it("⚠️ the page does NOT duplicate the island's upload fetch — it's fully extracted, not copied", () => {
    // Positive above proves the real upload fetch lives in media-upload.ts.
    // This negative proves new-post.astro carries no inline copy of it — a
    // duplicate would silently drift from the CSP-safe bundled version (and
    // an inline copy would be blocked outright by setPublicPageCsp anyway).
    expect(rawSource).not.toContain('fetch("/media-upload"');
  });

  it("sends the raw File as the body — no FormData/multipart wrapping", () => {
    expect(islandCode).toMatch(/body:\s*file/);
    expect(islandCode).not.toContain("FormData");
  });

  it("promotes the hidden csrfToken field to the X-CSRF-Token header client-side", () => {
    expect(islandCode).toMatch(/["']X-CSRF-Token["']:\s*tokenField\.value/);
  });

  it("inserts the returned url as a Markdown image reference at the cursor", () => {
    expect(islandCode).toMatch(/!\[\]\(\$\{data\.url\}\)/);
  });

  it("the upload island uses no inline event-handler attributes and no `is:inline`", () => {
    // ⚠️ Positive above (the previous test in this block) proves the real
    // fetch/DOM logic lives in this module. What is pinned here: no
    // `onclick=`-style attribute and no `is:inline` directive could sneak into
    // the MOUNT point left behind in new-post.astro — both would be strictly
    // worse than a bundled import (an attribute handler cannot be allowed by
    // ANY CSP directive short of 'unsafe-inline', and `is:inline` is what
    // public pages use for the ld+json block, never for executable JS).
    expect(rawSource).not.toMatch(/\son\w+\s*=\s*["']/);
    expect(rawSource).not.toMatch(/<script\s+is:inline[^>]*>[\s\S]*media-file/);
  });

  it("new-post.astro mounts the island as a BUNDLED module (an import), not inline JS", () => {
    // A <script> containing an import → Astro externalizes it → satisfies
    // script-src 'self' (setPublicPageCsp's policy, applied below).
    expect(code).toMatch(/import\s+\{\s*initMediaUpload\s*\}\s+from\s+["']\.\.\/scripts\/media-upload["']/);
    expect(code).toMatch(/\binitMediaUpload\(\)/);
  });
});

describe("CSRF token delivery (unchanged from M0)", () => {
  it("fetches the token from GET /auth/csrf, forwarding the session cookie", () => {
    expect(code).toMatch(/apiFetch[^;]*\/auth\/csrf["']/s);
  });

  it("renders it as a hidden input, never a readable cookie", () => {
    expect(rawSource).toMatch(/<input\s+type="hidden"\s+name="csrfToken"/);
  });

  it("shows a login link instead of the form when there is no session", () => {
    expect(code).toMatch(/csrfToken === null/);
    expect(rawSource).toContain('id="login-required"');
  });
});

describe("⚠️ theming + CSP retrofit — the media-upload island must be BUNDLED, not inline", () => {
  it("has NO inline script and carries the shared chrome + CSP", () => {
    // `code` = comment-stripped source read in this file
    // the media-upload island is now a bundled import, not inline JS
    expect(code).toMatch(/import\s+.*from\s+["']\.\.\/scripts\/media-upload["']/);
    expect(code).toContain("setPublicPageCsp(Astro)");
    expect(code).toMatch(/<BaseLayout\s/);
    expect(code).toContain("markPrivate(Astro)");
  });
});

describe("editing an existing post", () => {
  it("404s when the post does not belong to (or exist for) the caller", () => {
    expect(code).toMatch(/existing\.status !== 200|existing\.status === 200/);
    expect(code).toMatch(/status:\s*404/);
  });

  it("loads the existing title/markdownSource to prefill the form", () => {
    expect(code).toContain("existing.data.title");
    expect(code).toContain("existing.data.markdownSource");
  });
});

describe("⚠️ tags — no-JS, comma-separated (Task 6)", () => {
  it("has a no-JS comma-separated tags input", () => {
    expect(rawSource).toMatch(/<input\s+type="text"\s+id="tags"\s+name="tags"/);
  });

  it("threads tags into BOTH the create and edit apiFetch bodies", () => {
    const bodiesWithTags = code.match(/body:\s*\{[^}]*tags[^}]*\}/g) ?? [];
    expect(bodiesWithTags.length).toBe(2);
  });

  it("⚠️ adds NO island and NO new <script> — a plain form field, nothing more", () => {
    // Positive above proves the real input exists in markup. This negative
    // proves it did not arrive bundled with client JS: the only <script> on
    // this page must remain the pre-existing media-upload mount.
    expect(code).not.toContain("initTagsIsland");
    // `code` (comment-stripped), not `rawSource` — the header comment prose
    // mentions an inline `<script type="module">` in passing, which would
    // otherwise inflate a raw-source count without there being a second tag.
    const scriptTags = code.match(/<script/g) ?? [];
    expect(scriptTags.length).toBe(1);
  });

  it("pre-fills tagsValue from the existing post's tag labels on edit load", () => {
    expect(code).toMatch(/tagsValue\s*=\s*existing\.data\.tags\.map\(\s*\(?t\)?\s*=>\s*t\.label\s*\)\.join\(\s*["'],\s*["']\s*\)/);
  });

  it("re-renders the raw submitted tags string on a failed POST, not a re-derived one", () => {
    expect(code).toMatch(/tagsValue\s*=\s*tagsRaw/);
  });

  it("derives `tags` client-side by splitting on commas, trimming, dropping empties, capping at 5 — no slugification", () => {
    expect(code).toContain('const tagsRaw = String(form.get("tags") ?? "")');
    expect(code).toMatch(/tagsRaw\s*\.split\(\s*","\s*\)/);
    expect(code).toMatch(/\.slice\(\s*0,\s*5\s*\)/);
  });
});
