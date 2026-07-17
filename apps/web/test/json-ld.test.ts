import { describe, expect, it } from "vitest";

import { jsonLdScript } from "../src/lib/json-ld";

describe("jsonLdScript", () => {
  it("⚠️ escapes `<` so a title cannot break out of the <script> block", () => {
    // JSON.stringify does NOT escape `<` or `/`. A post titled
    // `</script><img src=x onerror=alert(1)>` would otherwise CLOSE the data
    // block and inject live markup — a stored XSS that bypasses the Markdown
    // sanitizer entirely, because the TITLE never goes through it.
    const out = jsonLdScript({ headline: "</script><img src=x onerror=alert(1)>" });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c");
  });

  it("stays valid JSON after escaping", () => {
    const data = { headline: "a </script> b", url: "https://e.com/x" };
    expect(JSON.parse(jsonLdScript(data))).toEqual(data);
  });

  it("escapes every `<`, not just the first", () => {
    expect(jsonLdScript({ a: "<<<" })).not.toContain("<");
  });
});
