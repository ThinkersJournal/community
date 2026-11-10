// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * A tolerant, NON-EXECUTING extractor for the few fields the web card shows (spec section 5 rule 7): `<title>`,
 * `og:title`, `og:description`, `og:site_name`, `og:image`, `twitter:image` and `<link rel=canonical>`, from the first
 * 512 KB of a page.
 *
 * It is a small bounded tokenizer, not an HTML parser: one forward pass, every search moves forward (so linear time on
 * any input), nothing is evaluated, nothing is fetched, and no input makes it throw. Raw-text elements (script, style,
 * textarea ...) and comments are skipped whole, so markup inside them is never read as a field. Hand-written rather
 * than HTMLRewriter so the behaviour is identical in the workerd test pool and in production and has no streaming
 * surprises. Output strings are plain text (entities decoded, control characters removed, whitespace collapsed) and
 * hard-capped; they are escaped again at render.
 */
import { ConnectorError, isInvisibleControl, SNAPSHOT_CAPS, truncateText, type ImageRef } from "@thinkersjournal/shared";

import { DEFAULT_SELF_HOSTS } from "./guarded-fetch";
import { assertPublicHttpUrl } from "./ssrf";

const MAX_INPUT_CHARS = 512 * 1024;
/** More than any capped field needs; a longer attribute value is cut before decoding. */
const MAX_VALUE_CHARS = 4096;
const WANTED_ATTRS: ReadonlySet<string> = new Set(["name", "property", "content", "rel", "href"]);
const WANTED_META: ReadonlySet<string> = new Set(["og:title", "og:description", "og:site_name", "og:image", "twitter:image"]);
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["script", "style", "textarea", "xmp", "iframe", "noembed", "noframes"]);

export interface OgFields {
  title?: string;
  description?: string;
  siteName?: string;
  canonicalUrl?: string;
  image?: ImageRef;
}

interface Collected {
  title: string | undefined;
  meta: Map<string, string>;
  canonicalHref: string | undefined;
}

interface ParsedValue {
  value: string;
  next: number;
}

interface StartTag {
  name: string;
  attrs: Map<string, string>;
  end: number;
}

const DOUBLE_QUOTE = String.fromCharCode(34);
const SINGLE_QUOTE = String.fromCharCode(39);
function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}
function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function quotedEnd(input: string, from: number, quote: string): number {
  const close = input.indexOf(quote, from + 1);
  return close < 0 ? input.length : close;
}

function unquotedEnd(input: string, from: number): number {
  let p = from;
  while (p < input.length && !isSpace(input.charCodeAt(p)) && input.charCodeAt(p) !== 62) p += 1;
  return p;
}

function parseValue(input: string, from: number): ParsedValue {
  const quote = input.charAt(from);
  const quoted = quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE;
  const start = quoted ? from + 1 : from;
  const stop = quoted ? quotedEnd(input, from, quote) : unquotedEnd(input, from);
  const next = quoted ? Math.min(stop + 1, input.length) : stop;
  return { value: input.slice(start, Math.min(stop, start + MAX_VALUE_CHARS)), next };
}

/** `start` is the index of the first character of the tag name. */
function parseStartTag(input: string, start: number): StartTag {
  const len = input.length;
  let p = start;
  while (p < len && !isSpace(input.charCodeAt(p)) && input[p] !== "/" && input[p] !== ">") p += 1;
  const name = input.slice(start, p).toLowerCase();
  const attrs = new Map<string, string>();
  for (;;) {
    while (p < len && (isSpace(input.charCodeAt(p)) || input[p] === "/")) p += 1;
    if (p >= len) return { name, attrs, end: len };
    if (input[p] === ">") return { name, attrs, end: p + 1 };
    const nameStart = p;
    p += 1; // always consume one character, so a stray "=" cannot stall the loop
    while (p < len && !isSpace(input.charCodeAt(p)) && input[p] !== "=" && input[p] !== ">" && input[p] !== "/") p += 1;
    const attr = input.slice(nameStart, p).toLowerCase();
    while (p < len && isSpace(input.charCodeAt(p))) p += 1;
    let value = "";
    if (input[p] === "=") {
      p += 1;
      while (p < len && isSpace(input.charCodeAt(p))) p += 1;
      const parsed = parseValue(input, p);
      value = parsed.value;
      p = parsed.next;
    }
    if (WANTED_ATTRS.has(attr) && !attrs.has(attr)) attrs.set(attr, value);
  }
}

const NAMED_ENTITIES: ReadonlyMap<string, number> = new Map([
  ["amp", 38], ["lt", 60], ["gt", 62], ["quot", 34], ["apos", 39], ["nbsp", 32],
  ["ndash", 8211], ["mdash", 8212], ["hellip", 8230], ["lsquo", 8216], ["rsquo", 8217],
  ["ldquo", 8220], ["rdquo", 8221], ["copy", 169], ["middot", 183],
]);

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    const named = NAMED_ENTITIES.get(body.toLowerCase());
    return named === undefined ? whole : String.fromCodePoint(named);
  });
}

function isControl(c: number): boolean {
  return c < 32 || (c >= 0x7f && c <= 0x9f) || isInvisibleControl(c);
}

/** Plain text, capped: entities decoded, whitespace collapsed to single spaces, control and zero-width characters gone. */
function cleanText(raw: string, cap: number): string {
  const out: string[] = [];
  let length = 0;
  let lastSpace = true;
  for (const ch of decodeEntities(raw)) {
    const c = ch.codePointAt(0) ?? 0;
    if (isSpace(c) || c === 0xa0 || c === 11) {
      if (lastSpace) continue;
      out.push(" ");
      length += 1;
      lastSpace = true;
    } else if (!isControl(c)) {
      out.push(ch);
      length += ch.length;
      lastSpace = false;
    }
    if (length >= cap) break;
  }
  return truncateText(out.join(""), cap).trim();
}

function recordMeta(attrs: Map<string, string>, out: Collected): void {
  const content = attrs.get("content");
  if (content === undefined) return;
  for (const attr of ["property", "name"]) {
    const key = attrs.get(attr)?.trim().toLowerCase();
    if (key !== undefined && WANTED_META.has(key) && !out.meta.has(key)) out.meta.set(key, content);
  }
}

function recordLink(attrs: Map<string, string>, out: Collected): void {
  const href = attrs.get("href");
  const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
  if (href !== undefined && rel.includes("canonical") && out.canonicalHref === undefined) out.canonicalHref = href;
}

/** Index just past a raw-text element's body (the position of its closing tag), or the end of input. */
function skipRawText(lower: string, name: string, from: number): number {
  const found = lower.indexOf(`</${name}`, from);
  return found < 0 ? lower.length : found;
}

/** ASCII-only lower-casing: unlike toLowerCase it never changes the string length, so indexes stay valid. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function readTitle(input: string, lower: string, from: number, out: Collected): number {
  const end = skipRawText(lower, "title", from);
  if (out.title === undefined) out.title = input.slice(from, Math.min(end, from + MAX_VALUE_CHARS * 2));
  return end;
}

/** Handle the markup starting at `lt` (an index of "<"). Returns the index to continue from; always greater than `lt`. */
function handleMarkup(input: string, lower: string, lt: number, out: Collected): number {
  const len = input.length;
  if (input.startsWith("<!--", lt)) {
    const close = input.indexOf("-->", lt + 4);
    return close < 0 ? len : close + 3;
  }
  const next = input[lt + 1];
  if (next === "!" || next === "?" || next === "/") {
    const close = input.indexOf(">", lt + 2);
    return close < 0 ? len : close + 1;
  }
  if (next === undefined || !isLetter(input.charCodeAt(lt + 1))) return lt + 1;
  const tag = parseStartTag(input, lt + 1);
  if (tag.name === "meta") recordMeta(tag.attrs, out);
  else if (tag.name === "link") recordLink(tag.attrs, out);
  else if (tag.name === "title") return readTitle(input, lower, tag.end, out);
  else if (RAW_TEXT_TAGS.has(tag.name)) return skipRawText(lower, tag.name, tag.end);
  return tag.end;
}

function scan(input: string): Collected {
  const out: Collected = { title: undefined, meta: new Map(), canonicalHref: undefined };
  const lower = asciiLower(input);
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt < 0) break;
    i = handleMarkup(input, lower, lt, out);
  }
  return out;
}

function passesUrlRules(url: URL): boolean {
  try {
    assertPublicHttpUrl(url);
    return true;
  } catch (e) {
    if (e instanceof ConnectorError) return false;
    throw e;
  }
}

function resolveUrl(rawValue: string, base: string): URL | undefined {
  const raw = decodeEntities(rawValue).trim();
  if (raw === "" || raw.length > SNAPSHOT_CAPS.url) return undefined;
  try {
    const url = new URL(raw, base);
    return url.href.length <= SNAPSHOT_CAPS.url ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Resolved against the final URL, kept only if https and it passes the SSRF URL rules. It is never fetched. */
function pickImage(candidates: ReadonlyArray<string | undefined>, base: string): ImageRef | undefined {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const url = resolveUrl(candidate, base);
    if (url && url.protocol === "https:" && passesUrlRules(url)) return { storage: "remote", url: url.href };
  }
  return undefined;
}

/** Kept only if https, public by the URL rules, and not one of our own hosts (no self-referencing card). */
function pickCanonical(href: string | undefined, base: string, selfHosts: ReadonlySet<string>): string | undefined {
  if (href === undefined) return undefined;
  const url = resolveUrl(href, base);
  if (!url || url.protocol !== "https:" || !passesUrlRules(url)) return undefined;
  return selfHosts.has(url.hostname.toLowerCase().replace(/[.]$/, "")) ? undefined : url.href;
}

function firstText(cap: number, ...raws: ReadonlyArray<string | undefined>): string | undefined {
  for (const raw of raws) {
    if (raw === undefined) continue;
    const text = cleanText(raw, cap);
    if (text !== "") return text;
  }
  return undefined;
}

/** Extract the card fields from page HTML. Never throws; absent fields are simply missing from the result. */
export function parseOpenGraph(html: string, finalUrl: string, selfHosts: readonly string[] = DEFAULT_SELF_HOSTS): OgFields {
  const found = scan(html.length > MAX_INPUT_CHARS ? html.slice(0, MAX_INPUT_CHARS) : html);
  const fields: OgFields = {};
  const title = firstText(SNAPSHOT_CAPS.title, found.meta.get("og:title"), found.title);
  const description = firstText(SNAPSHOT_CAPS.description, found.meta.get("og:description"));
  const siteName = firstText(SNAPSHOT_CAPS.siteName, found.meta.get("og:site_name"));
  const canonicalUrl = pickCanonical(found.canonicalHref, finalUrl, new Set(selfHosts.map((h) => h.toLowerCase())));
  const image = pickImage([found.meta.get("og:image"), found.meta.get("twitter:image")], finalUrl);
  if (title !== undefined) fields.title = title;
  if (description !== undefined) fields.description = description;
  if (siteName !== undefined) fields.siteName = siteName;
  if (canonicalUrl !== undefined) fields.canonicalUrl = canonicalUrl;
  if (image !== undefined) fields.image = image;
  return fields;
}
