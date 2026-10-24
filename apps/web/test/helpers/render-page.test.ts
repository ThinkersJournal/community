// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, it } from "vitest";

import NewPost from "../../src/pages/new-post.astro";
import { json, renderPage } from "./render-page";

/**
 * Proves the render helper itself works under plain Node vitest: a real
 * `.astro` page is compiled and rendered, and its `apiFetch` reaches the fake
 * Service Binding. Does NOT prove anything about workerd, the Cloudflare
 * adapter, middleware, or the real api's response shapes.
 */
describe("renderPage", () => {
  it("renders new-post.astro to HTML through the fake API binding", async () => {
    const seen: string[] = [];
    const res = await renderPage(NewPost, {
      url: "http://localhost/new-post",
      api: (url) => {
        seen.push(new URL(url).pathname);
        return json(401, { code: "UNAUTHENTICATED" });
      },
    });
    const html = await res.text();
    expect(seen).toContain("/auth/csrf");
    expect(html).toContain('id="login-required"');
    expect(html).toContain("<h1>New post</h1>");
  });
});
