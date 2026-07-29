import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "pages", "api");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = stripComments(readFileSync(join(DIR, "notifications-ws.ts"), "utf8"));

describe("notifications-ws proxy", () => {
  it("forwards the upgrade to /notifications/ws over the API Service Binding, carrying all headers", () => {
    expect(code).toContain("/notifications/ws");
    expect(code).toContain("API.fetch"); // over the Service Binding
    expect(code).toContain("context.request.headers"); // wholesale forward: Cookie + Origin + Sec-WebSocket-*
    expect(code).toContain("Upgrade"); // gates on the upgrade
  });

  it("hand-reconstructs the 101 (Task-0 spike: the adapter won't pass a raw 101 through)", () => {
    expect(code).toContain("101");
    expect(code).toContain("webSocket");
  });

  it("is prerender=false", () => {
    expect(code).toContain("export const prerender = false");
  });

  it("declares itself uncacheable via markPrivate and never uses apiFetch (which would consume the 101)", () => {
    expect(code).toContain("markPrivate");
    expect(code).not.toContain("apiFetch");
  });
});
