/**
 * THE ONE ISLAND on new-post.astro. Everything else on that page is a plain
 * form POST; a file is the one thing that cannot reach the server without JS.
 *
 * ⚠️ BUNDLED, NOT INLINE — the reason this module exists at all. Astro leaves
 * a `<script type="module">` with no `import` INLINE in the rendered HTML;
 * only a script that imports something gets externalized to `/_astro/*.js`.
 * new-post.astro now carries `setPublicPageCsp` (`script-src 'self'`, no
 * `'unsafe-inline'`) via BaseLayout's shared chrome, so an inline script would
 * be BLOCKED outright. Moving the body here and mounting it via
 * `<script>import { initMediaUpload } from "../scripts/media-upload"; …`
 * gives Astro an `import` to bundle, which is what makes the page CSP-safe.
 * See the task report for the built-output check that confirms this lands
 * under `dist/…/_astro/*.js`.
 *
 * ⚠️ Uploads to /media-upload (same-origin), NOT to the api directly: the api
 * has no public route, and same-origin-by-construction is what makes its
 * Origin allowlist meaningful.
 */
export function initMediaUpload(): void {
  const input = document.querySelector<HTMLInputElement>("#media-file");
  const status = document.querySelector<HTMLParagraphElement>("#media-status");
  const textarea = document.querySelector<HTMLTextAreaElement>("#markdownSource");
  const tokenField = document.querySelector<HTMLInputElement>("input[name='csrfToken']");

  input?.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file === undefined || status === null || textarea === null || tokenField === null) return;

    status.textContent = "Uploading…";
    input.disabled = true;
    try {
      const response = await fetch("/media-upload", {
        method: "POST",
        // The api demands this header and a form cannot set one — which is
        // exactly why the token round-trips through the page.
        headers: { "X-CSRF-Token": tokenField.value },
        // The raw File, sent as-is. NOT FormData/multipart: POST /media
        // takes raw bytes (apps/api/src/routes/media.ts's header explains
        // why), and a browser `fetch` body of a `File` is already exactly
        // that — no wrapping needed.
        body: file,
      });
      const data = (await response.json()) as { url?: string; code?: string };
      if (!response.ok || data.url === undefined) {
        // The api's error envelope: {code, message?}. Show the code — the
        // messages are deliberately generic (they must not echo a
        // filename), and the code is enough to tell 413/415/403 apart.
        status.textContent = `Upload failed (${data.code ?? response.status}).`;
        return;
      }
      // Insert at the cursor rather than appending: an image belongs
      // where the author was typing.
      const at = textarea.selectionStart ?? textarea.value.length;
      const markdown = `\n![](${data.url})\n`;
      textarea.value = textarea.value.slice(0, at) + markdown + textarea.value.slice(at);
      status.textContent = "Inserted.";
    } catch {
      status.textContent = "Upload failed.";
    } finally {
      input.disabled = false;
      input.value = "";
    }
  });
}
