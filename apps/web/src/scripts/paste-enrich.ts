// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Pure helpers for paste-to-enrich (M3.4c). Pasting a bare link into the editor never changes what the author typed:
 * the URL stays as ordinary text, the picker's URL box is filled and the status line offers a card. If the author
 * accepts, the URL's own line becomes the `{{ref:TOKEN}}` marker; if that line was edited in the meantime nothing is
 * replaced and the marker is inserted at the cursor as before.
 */

/** The URL when `text` is exactly one http(s) link (surrounding whitespace allowed), else null. */
export function bareUrl(text: string): string | null {
  const t = text.trim();
  if (t === "" || /\s/.test(t)) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? t : null;
  } catch {
    return null;
  }
}

/**
 * Replace the FIRST line whose trimmed text is exactly `url` with `{{ref:token}}`. Null when no such line exists.
 * Line endings (LF or CRLF) are preserved.
 */
export function replaceUrlLineWithRef(value: string, url: string, token: string): string | null {
  const lines = value.split("\n");
  const at = lines.findIndex((line) => line.trim() === url);
  if (at === -1) return null;
  const ending = lines[at]!.endsWith("\r") ? "\r" : "";
  lines[at] = `{{ref:${token}}}${ending}`;
  return lines.join("\n");
}
