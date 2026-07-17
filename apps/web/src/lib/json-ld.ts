/**
 * Serialize data for a `<script type="application/ld+json">` block.
 *
 * ⚠️ THE ESCAPE IS A REAL XSS DEFENSE, NOT TIDINESS. JSON.stringify does not
 * escape `<`, so a post titled `</script><img src=x onerror=alert(1)>` would
 * close the data block and inject live markup. That path bypasses the Markdown
 * sanitizer completely — the TITLE never goes through packages/markdown — so this
 * function is the only thing standing in front of it. `<` is valid JSON and
 * parses back to `<`, so nothing is lost. test/json-ld.test.ts pins it.
 *
 * ⚠️ A ld+json BLOCK IS NOT SUBJECT TO `script-src`. CSP governs scripts that are
 * EXECUTED; a `<script>` with a non-JS type is an inert data block. So `script-src
 * 'self'` (src/lib/csp.ts) does NOT block this — and equally does not protect it.
 *
 * ⚠️ THIS IS THE ONLY SAFE WAY TO GET DATA INTO THAT BLOCK. It must be paired
 * with `set:html`, because Astro would otherwise HTML-escape the JSON and break
 * the parse. `set:html` means Astro's own escaping is off, which is precisely
 * why the escape below is not optional.
 */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
