/**
 * Prefill the CREATE form of new-post.astro from the URL fragment (design
 * 2026-10-13, section 4; route A agreed with the CodeRipper lane 2026-10-12):
 *
 *   GET /new-post#cr=<base64url(JSON {title, markdownSource, tags, key})>
 *
 * The fragment never reaches a server. This script reads it ONCE, sets the
 * fields, and clears the hash. The user still presses Publish or Save draft.
 *
 * ⚠️ UNTRUSTED INPUT. The fragment is whatever link the user followed. Values go
 * in with `.value`, never `innerHTML`; every field is type- and size-checked;
 * anything malformed is ignored as a whole. `key` replaces the form's hidden
 * Idempotency-Key ONLY if it matches the same shape the api enforces
 * (`KEY_SHAPE`); otherwise the generated key stays.
 *
 * ⚠️ BUNDLED, NOT INLINE, like media-upload.ts: new-post.astro's CSP is
 * `script-src 'self'`.
 */

/**
 * The api's key shape (`IDEMPOTENCY_KEY_RE` in packages/shared/src/posts.ts).
 * ⚠️ DUPLICATED ON PURPOSE: this module ships to the BROWSER, and importing the
 * shared barrel would pull zod into the bundle for one regex.
 * test/editor-prefill.test.ts pins the two to the same source.
 */
export const KEY_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

/** Limits mirror the api's CreatePostInput (title 200, markdown 100k, 5 tags of 50). */
const TITLE_MAX = 200;
const MARKDOWN_MAX = 100_000;
const TAGS_MAX = 5;
const TAG_MAX = 50;
/** A fragment far past the limits above is not worth decoding. */
const FRAGMENT_MAX = 400_000;

export interface EditorPrefill {
  title?: string;
  markdownSource?: string;
  tags?: string[];
  key?: string;
}

function decodeBase64Url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Parse a `location.hash`. Returns null for anything that is not a well-formed `#cr=` payload. */
export function parsePrefillFragment(hash: string): EditorPrefill | null {
  if (hash.length > FRAGMENT_MAX) return null;
  const match = /^#cr=([A-Za-z0-9_-]+)$/.exec(hash);
  if (match === null) return null;
  const json = decodeBase64Url(match[1]!);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const out: EditorPrefill = {};
  if (r["title"] !== undefined) {
    if (typeof r["title"] !== "string" || r["title"].length > TITLE_MAX) return null;
    out.title = r["title"];
  }
  if (r["markdownSource"] !== undefined) {
    if (typeof r["markdownSource"] !== "string" || r["markdownSource"].length > MARKDOWN_MAX) return null;
    out.markdownSource = r["markdownSource"];
  }
  if (r["tags"] !== undefined) {
    const tags = r["tags"];
    if (!Array.isArray(tags) || tags.length > TAGS_MAX) return null;
    if (!tags.every((t): t is string => typeof t === "string" && t.length > 0 && t.length <= TAG_MAX && !t.includes(","))) return null;
    out.tags = tags;
  }
  // A malformed key is dropped, not fatal: the rest of the prefill is still wanted.
  if (typeof r["key"] === "string" && KEY_SHAPE.test(r["key"])) out.key = r["key"];
  return out;
}

export function initEditorPrefill(): void {
  // Create form only: the hidden key exists only there.
  const keyField = document.querySelector<HTMLInputElement>("#editor-form input[name='idempotencyKey']");
  if (keyField === null) return;
  const prefill = parsePrefillFragment(window.location.hash);
  if (prefill === null) return;

  const title = document.querySelector<HTMLInputElement>("#title");
  const body = document.querySelector<HTMLTextAreaElement>("#markdownSource");
  const tags = document.querySelector<HTMLInputElement>("#tags");
  if (prefill.title !== undefined && title !== null) title.value = prefill.title;
  if (prefill.markdownSource !== undefined && body !== null) body.value = prefill.markdownSource;
  if (prefill.tags !== undefined && tags !== null) tags.value = prefill.tags.join(", ");
  if (prefill.key !== undefined) keyField.value = prefill.key;

  // Once: a reload must not overwrite the user's edits.
  history.replaceState(null, "", window.location.pathname + window.location.search);
}
