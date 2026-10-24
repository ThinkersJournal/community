// SPDX-License-Identifier: MIT OR Apache-2.0
import { ACCESS_JWT_HEADER } from "@thinkersjournal/shared";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApiFetch } from "../src/lib/admin-api";
import Page from "../src/pages/admin/security.astro";

/**
 * RENDERED test of /admin/security (security-alerting PR 3): the real .astro
 * page goes through Astro's container API, with only `adminApiFetch` mocked
 * (the api itself is out of scope). Runs under the default web vitest config (Astro
 * container API, `cloudflare:workers` aliased to a Node stub).
 *
 * The page's source-level tests (admin-security-page.test.ts) can only say
 * "no set:html"; this says what the OUTPUT does with hostile text.
 */
vi.mock("../src/lib/admin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/admin-api")>()),
  adminApiFetch: vi.fn(),
}));

const mockedFetch = vi.mocked(adminApiFetch);
const HOSTILE = '"><script>x</script>';
const ESCAPED = "&lt;script&gt;x&lt;/script&gt;";
const REF = "0123456789abcdef0123456789abcdef";
const ALL_CLASSES = ["account", "stuffing", "ip_burst", "infra"];

interface Reply {
  status: number;
  data: unknown;
}

function reply(status: number, data: unknown): Awaited<ReturnType<typeof adminApiFetch>> {
  return { status, data, text: JSON.stringify(data), setCookies: [] };
}

/** Route the two api calls the page makes; an unlisted call fails the test loudly. */
function serve(handlers: { ref?: Reply; held?: Reply }): void {
  mockedFetch.mockImplementation((path) => {
    const h = path.startsWith("/admin/security/account-ref/") ? handlers.ref : handlers.held;
    if (h === undefined) throw new Error(`unexpected api call: ${path}`);
    return Promise.resolve(reply(h.status, h.data));
  });
}

async function render(query: string, jwt: string | null = "access-jwt"): Promise<{ status: number; html: string }> {
  const container = await AstroContainer.create();
  const headers = new Headers();
  if (jwt !== null) headers.set(ACCESS_JWT_HEADER, jwt);
  const response = await container.renderToResponse(Page, {
    request: new Request(`https://admin.test/admin/security${query}`, { headers }),
  });
  return { status: response.status, html: await response.text() };
}

/**
 * The page's markup with every quoted attribute value removed: what is left is
 * the element structure and the text nodes. Astro escapes `"` inside an attribute
 * value (so it cannot be closed early), which is why attribute values are checked
 * separately, for an unescaped quote, rather than for `<`.
 */
function structure(html: string): string {
  return html.replace(/="[^"]*"/g, '=""');
}

const heldPage = (over: Record<string, unknown> = {}): Reply => ({
  status: 200,
  data: {
    signalClass: "account",
    rows: [
      {
        subjectKey: `targeted_account|${REF}`,
        signal: "targeted_account",
        subject: { kind: "account", ref: REF },
        events: 31,
        suppressed: 2,
        version: 4,
        open: true,
      },
    ],
    nextAfter: null,
    classOrder: ALL_CLASSES,
    ...over,
  },
});

beforeEach(() => {
  // Braces matter: a beforeEach that RETURNS a function has it run as teardown, which would call the mock with no arguments.
  mockedFetch.mockReset();
});

describe("/admin/security rendered: positive controls", () => {
  it("no Access JWT: 401 with an empty body, and no api call", async () => {
    const out = await render("", null);
    expect(out.status).toBe(401);
    expect(out.html).toBe("");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("a normal held page renders the row, the class tabs and the page title", async () => {
    serve({ held: heldPage() });
    const { status, html } = await render("?class=account");
    expect(status).toBe(200);
    expect(html).toMatch(/<h1[^>]*>Security<\/h1>/);
    expect(html).toContain(`account ref ${REF}`);
    for (const c of ALL_CLASSES) expect(html).toContain(`href="?class=${c}"`);
  });

  it("a valid ref is resolved through the api and shown as the handle's link", async () => {
    serve({ ref: { status: 200, data: { userId: "u1", handle: "alice" } }, held: heldPage() });
    const { html } = await render(`?ref=${REF}`);
    expect(mockedFetch).toHaveBeenCalledWith(`/admin/security/account-ref/${REF}`, { accessJwt: "access-jwt" });
    expect(html).toContain('href="/admin/accounts/alice"');
    expect(html).toContain("@alice");
  });
});

describe("/admin/security rendered: hostile input is escaped or dropped", () => {
  it("a hostile ref never reaches the api or the output (not even in the form field)", async () => {
    serve({ held: heldPage() });
    const { html } = await render(`?ref=${encodeURIComponent(HOSTILE)}`);
    expect(html).toContain("No such reference");
    expect(html).not.toContain(HOSTILE);
    expect(structure(html)).not.toContain("<script>x");
    expect(mockedFetch.mock.calls.some(([p]) => p.startsWith("/admin/security/account-ref/"))).toBe(false);
  });

  it("a hostile class is the unknown-class message, is not echoed, and is not forwarded to the api", async () => {
    serve({});
    const { html } = await render(`?class=${encodeURIComponent(HOSTILE)}`);
    expect(html).toContain("Could not load the held list: UNKNOWN_CLASS");
    for (const c of ALL_CLASSES) expect(html).toContain(`href="?class=${c}"`);
    expect(html).not.toContain(HOSTILE);
    expect(structure(html)).not.toContain("<script>x");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("a hostile `after` goes to the api URL-encoded only, and is not echoed in the output", async () => {
    serve({ held: heldPage() });
    const { html } = await render(`?class=account&after=${encodeURIComponent(HOSTILE)}`);
    const path = String(mockedFetch.mock.calls[0]?.[0]);
    expect(path).toBe(`/admin/security/held?class=account&after=${encodeURIComponent(HOSTILE)}`);
    expect(html).not.toContain(HOSTILE);
    expect(structure(html)).not.toContain("<script>x");
  });

  it("hostile strings inside api replies are HTML-escaped: handle, signal, ip prefix, cursor, class order", async () => {
    serve({
      ref: { status: 200, data: { userId: "u1", handle: HOSTILE } },
      held: heldPage({
        rows: [
          {
            subjectKey: "k",
            signal: HOSTILE,
            subject: { kind: "ip_prefix", value: HOSTILE },
            events: 1,
            suppressed: 0,
            version: 1,
            open: false,
          },
        ],
        nextAfter: HOSTILE,
        classOrder: [HOSTILE, "account"],
      }),
    });
    const { html } = await render(`?ref=${REF}`);
    expect(structure(html)).not.toContain("<script>x");
    expect(html).not.toContain('"><script>');
    expect(html).toContain(ESCAPED);
    // The class link built from the api's classOrder: percent-encoded, so no markup reaches the attribute.
    expect(html).toContain('href="?class=%22%3E%3Cscript%3Ex%3C%2Fscript%3E"');
    // The handle goes into an href percent-encoded, not raw.
    expect(html).toContain(`/admin/accounts/${encodeURIComponent(HOSTILE)}`);
    // The cursor in "Next page" is percent-encoded.
    expect(html).toContain(`after=${encodeURIComponent(HOSTILE)}`);
  });

  it("a hostile classOrder entry is percent-encoded in its class link href", async () => {
    serve({ held: heldPage({ classOrder: [HOSTILE, "account"] }) });
    const { html } = await render("?class=account");
    expect(html).toContain(`href="?class=${encodeURIComponent(HOSTILE)}"`);
    expect(html).toContain('href="?class=%22%3E%3Cscript%3Ex%3C%2Fscript%3E"');
    expect(structure(html)).not.toContain("<script>x");
  });

  it("hostile api error codes are escaped (ref lookup and list)", async () => {
    serve({ ref: { status: 404, data: { code: HOSTILE } }, held: { status: 500, data: { code: HOSTILE } } });
    const { html } = await render(`?ref=${REF}`);
    const escaped = HOSTILE.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    expect(html).toContain(`No such reference (unknown, or unused for 7 days): ${escaped}`);
    expect(html).toContain(`Could not load the held list: ${escaped}`);
    expect(structure(html)).not.toContain("<script>x");
  });
});

describe("/admin/security rendered: the two previously source-grep-only messages", () => {
  it("an expired cursor: the clear message and a link to the class's first page, not a generic failure", async () => {
    serve({ held: { status: 400, data: { code: "INVALID_INPUT", fields: ["after"] } } });
    const { html } = await render("?class=stuffing&after=stuffing%7Cdeadbeef");
    expect(html).toContain('id="cursor-expired"');
    expect(html).toContain("This page's cursor has expired");
    expect(html).toContain('href="?class=stuffing"');
    expect(html).not.toContain("Could not load the held list");
  });

  it("a non-cursor 400 is the generic failure, not the expired-cursor message (negative control)", async () => {
    serve({ held: { status: 400, data: { code: "INVALID_INPUT", fields: ["class"] } } });
    const { html } = await render("?class=stuffing");
    expect(html).not.toContain('id="cursor-expired"');
    expect(html).toContain("Could not load the held list: INVALID_INPUT");
  });

  it("an unknown class: the unknown-class message with the class links to pick from", async () => {
    serve({});
    const { html } = await render("?class=purge");
    expect(html).toContain("Could not load the held list: UNKNOWN_CLASS");
    expect(html).toContain('href="?class=infra"');
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
