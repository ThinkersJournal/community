// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The "Insert a link card" island on new-post.astro (M3.4b). BUNDLED, not inline, for the same CSP reason as
 * media-upload.ts (see its header): the page is `script-src 'self'`, and only a script that `import`s something is
 * externalized to `/_astro/*.js`.
 *
 * Posts `{postId, url}` to the same-origin proxy /api/post-reference. On success the returned token is written into
 * the Markdown textarea as `{{ref:TOKEN}}` on its own line at the cursor. On ANY failure only the status line
 * changes: the textarea is never touched, so a failed card cannot lose the author's text. All DOM writes go through
 * `.value` / `.textContent`, never innerHTML.
 */

import { bareUrl, replaceUrlLineWithRef } from "./paste-enrich";

export interface Inserted {
  value: string;
  cursor: number;
}

/** Insert `{{ref:TOKEN}}` on its own line at `cursor` (clamped). Pure. */
export function insertRefAtCursor(value: string, cursor: number, token: string): Inserted {
  const at = Math.min(Math.max(Number.isFinite(cursor) ? Math.trunc(cursor) : value.length, 0), value.length);
  const before = value.slice(0, at);
  const lead = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
  const insertion = `${lead}{{ref:${token}}}\n`;
  return { value: before + insertion + value.slice(at), cursor: before.length + insertion.length };
}

/**
 * Plain-language message for a failed attempt. `status` is null for a network failure. Never echoes server-supplied
 * strings (the `reason` is not shown), so nothing from the response can reach the page as markup or prose.
 */
export function messageForFailure(status: number | null, _body: unknown): string {
  if (status === null) return "Could not reach the server. Your text is unchanged; try again.";
  if (status === 404) return "Save the post first, then add the card. Your text is unchanged.";
  if (status === 429) return "Too many link cards just now. Try again a little later. Your text is unchanged.";
  if (status === 422) return "That link could not be turned into a card. It stays an ordinary link; your text is unchanged.";
  return "Something went wrong adding the card. Your text is unchanged.";
}

export function initReferencePicker(): void {
  const fieldset = document.querySelector<HTMLElement>("#ref-picker");
  const input = document.querySelector<HTMLInputElement>("#ref-url");
  const button = document.querySelector<HTMLButtonElement>("#ref-add");
  const status = document.querySelector<HTMLParagraphElement>("#ref-status");
  const textarea = document.querySelector<HTMLTextAreaElement>("#markdownSource");
  const tokenField = document.querySelector<HTMLInputElement>("input[name='csrfToken']");
  const postId = fieldset?.dataset.postId;
  if (!fieldset || !input || !button || !status || !textarea || !tokenField || !postId) return;

  // M3.4c: the last bare link pasted into the editor. The paste itself is never altered; accepting the offer turns
  // that URL's own line into the card marker.
  let pasted: string | null = null;

  const submit = async (): Promise<void> => {
    const url = input.value.trim();
    if (url === "") {
      status.textContent = "Paste a link first.";
      return;
    }
    status.textContent = "Adding card…";
    button.disabled = true;
    try {
      const response = await fetch("/api/post-reference", {
        method: "POST",
        headers: { "content-type": "application/json", "X-CSRF-Token": tokenField.value },
        body: JSON.stringify({ postId, url }),
      });
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        data = undefined;
      }
      const token = (data as { token?: unknown } | undefined)?.token;
      if (!response.ok || typeof token !== "string" || token === "") {
        status.textContent = messageForFailure(response.status, data);
        return;
      }
      // ONE textarea write, on this success path only (pinned by reference-picker.test.ts).
      const replaced = url === pasted ? replaceUrlLineWithRef(textarea.value, url, token) : null;
      const at = textarea.selectionStart ?? textarea.value.length;
      const next = replaced !== null ? { value: replaced, cursor: Math.min(at, replaced.length) } : insertRefAtCursor(textarea.value, at, token);
      textarea.value = next.value;
      textarea.setSelectionRange(next.cursor, next.cursor);
      pasted = null;
      input.value = "";
      status.textContent = "Card added. It shows when you save.";
    } catch {
      status.textContent = messageForFailure(null, undefined);
    } finally {
      button.disabled = false;
    }
  };

  textarea.addEventListener("paste", (event) => {
    const url = bareUrl(event.clipboardData?.getData("text/plain") ?? "");
    if (url === null) return;
    pasted = url;
    input.value = url;
    status.textContent = "Link pasted. Press Add card to turn it into a card, or ignore this to keep it as a link.";
  });
  button.addEventListener("click", () => void submit());
  // Enter in the URL box adds the card; it must not submit the editor (we are outside the form, but be explicit).
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  });
}
