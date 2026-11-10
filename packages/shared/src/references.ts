// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * M3 reference engine: the connector contract's types and the two pure helpers every connector shares
 * (`capSnapshot`, `contentHash`). Source of truth: docs/superpowers/specs/2026-11-09-m3-connector-contract.md
 * sections 3 and 4.3. No I/O in this file.
 */

export type SourceKind = "web" | "github" | "gitlab";

export interface Identified {
  kind: SourceKind;
  canonicalUrl: string;
  /** Stable identity, e.g. "github:o/r#pr:12". */
  resourceKey: string;
}

/** Launch writes only `remote`; `stored` is the future R2 copy (spec 4.3). */
export type ImageRef =
  | { storage: "remote"; url: string; width?: number; height?: number; alt?: string }
  | { storage: "stored"; key: string; width: number; height: number; alt?: string };

export type WebSnapshot = {
  kind: "web";
  title: string;
  description?: string;
  siteName?: string;
  image?: ImageRef;
  finalUrl: string;
};

export type RepoSnapshot = {
  kind: "github" | "gitlab";
  type: "issue" | "pr" | "file" | "check";
  title: string;
  state: string;
  author?: string;
  excerpt?: string;
  lines?: [number, number];
  path?: string;
  /** A commit SHA. */
  ref?: string;
  capturedAt: string;
};

export type Snapshot = WebSnapshot | RepoSnapshot;

/** Access and diff are kept apart: a change we cannot see is not "gone". */
export type Access = "ok" | "not_modified" | "gone" | "forbidden" | "rate_limited" | "error";
export type Diff = "unchanged" | "changed" | "resolved" | "gone" | "unknown";

export interface Resolved {
  resourceKey: string;
  snapshot: Snapshot;
  etag?: string;
  lastModified?: string;
  contentHash: string;
  license?: string;
}

export interface LiveResult {
  access: Access;
  diff: Diff;
  snapshot?: Snapshot;
  etag?: string;
  lastModified?: string;
  contentHash?: string;
}

/** What a connector needs of a stored `references` row. */
export interface StoredReference {
  kind: SourceKind;
  resourceKey: string;
  canonicalUrl: string;
  snapshot: Snapshot | null;
  etag?: string;
  lastModified?: string;
  contentHash: string;
}

export const CONNECTOR_ERROR_CODES = [
  "invalid_url",
  "blocked_target",
  "too_large",
  "timeout",
  "unsupported",
  "not_found",
  "upstream",
] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

const RETRYABLE_BY_DEFAULT: ReadonlySet<ConnectorErrorCode> = new Set(["timeout", "upstream"]);

/**
 * The only error a connector may throw (spec 3.2). The `message` is for logs; no upstream string is ever echoed
 * to a user, who sees fixed copy keyed by `code`.
 */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryable: boolean;

  constructor(code: ConnectorErrorCode, message?: string, retryable?: boolean) {
    super(message ?? code);
    this.name = "ConnectorError";
    this.code = code;
    this.retryable = retryable ?? RETRYABLE_BY_DEFAULT.has(code);
  }
}

/** Options a connector may pass through the guarded door; the guard's own limits are not overridable upward. */
export interface FetchInit {
  headers?: Record<string, string>;
  /** `too_large` (default): exceeding the byte cap throws. `truncate`: keep the first `maxBytes` and stop reading. */
  overflow?: "too_large" | "truncate";
  /** Lower-case media types accepted on a 2xx response (`"*"` accepts any). Default: html and xhtml. */
  allowedTypes?: readonly string[];
}

export interface FetchedPage {
  status: number;
  /** The URL after redirects. */
  finalUrl: string;
  contentType: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Decoded text, at most the byte cap; empty on a non-2xx. */
  body: string;
  truncated: boolean;
}

/** The only door to the network for a connector (spec 3.3). A connector may not call global `fetch`. */
export interface FetchCtx {
  fetch(url: string | URL, init?: FetchInit): Promise<FetchedPage>;
}

export const SNAPSHOT_CAPS = {
  title: 300,
  description: 600,
  siteName: 200,
  author: 100,
  state: 100,
  path: 500,
  ref: 64,
  alt: 300,
  url: 2048,
  /** 4 KB in the spec; enforced as 4096 UTF-16 code units (JavaScript string length), not bytes. The 16 KB total is in bytes. */
  excerptUtf16Units: 4096,
  capturedAt: 40,
  imageKey: 512,
  excerptLines: 40,
  totalJsonBytes: 16 * 1024,
} as const;

/**
 * Characters that render as nothing or reorder text: bidi embeddings, overrides, isolates and marks (U+202A-202E,
 * U+2066-2069, U+200E, U+200F, U+061C), zero-width characters (U+200B-200D), U+180E, line/paragraph separators and the
 * byte order mark. Untrusted text must not carry them: a right-to-left override makes a file name display reversed.
 */
export function isInvisibleControl(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x061c ||
    code === 0x180e ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfeff
  );
}

/** `text` without its invisible/bidi control characters. Newlines are kept (excerpts need them). */
export function stripInvisibleControls(text: string): string {
  let out = "";
  for (const ch of text) {
    if (!isInvisibleControl(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

/** Cut to at most `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function truncateText(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function capStrings<T extends object>(value: T, caps: Readonly<Record<string, number>>): T {
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  for (const [key, max] of Object.entries(caps)) {
    const current = out[key];
    if (typeof current === "string") out[key] = truncateText(current, max);
  }
  return out as unknown as T;
}

function capImage(image: ImageRef): ImageRef | undefined {
  if (image.storage === "remote" && image.url.length > SNAPSHOT_CAPS.url) return undefined;
  if (image.storage === "stored" && image.key.length > SNAPSHOT_CAPS.imageKey) return undefined;
  return capStrings(image, { alt: SNAPSHOT_CAPS.alt });
}

function capExcerpt(excerpt: string): string {
  const lines = excerpt.split("\n");
  const kept = lines.length > SNAPSHOT_CAPS.excerptLines ? lines.slice(0, SNAPSHOT_CAPS.excerptLines).join("\n") : excerpt;
  return truncateText(kept, SNAPSHOT_CAPS.excerptUtf16Units);
}

const TEXT_FIELDS = ["title", "description", "siteName", "author", "state", "path", "ref", "excerpt"] as const;

function cleanImage(image: ImageRef): ImageRef {
  return image.alt === undefined ? image : { ...image, alt: stripInvisibleControls(image.alt) };
}

/** Strip invisible controls from every free-text field (top level and the image's alt). */
function cleanText(snapshot: Snapshot): Snapshot {
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(snapshot));
  for (const field of TEXT_FIELDS) {
    const value = out[field];
    if (typeof value === "string") out[field] = stripInvisibleControls(value);
  }
  const cleaned = out as unknown as Snapshot;
  return cleaned.kind === "web" && cleaned.image ? { ...cleaned, image: cleanImage(cleaned.image) } : cleaned;
}

function capFields(snapshot: Snapshot): Snapshot {
  if (snapshot.kind === "web") {
    const { image, ...rest } = snapshot;
    const capped = capStrings(rest, {
      title: SNAPSHOT_CAPS.title,
      description: SNAPSHOT_CAPS.description,
      siteName: SNAPSHOT_CAPS.siteName,
      finalUrl: SNAPSHOT_CAPS.url,
    });
    const cappedImage = image ? capImage(image) : undefined;
    return cappedImage ? { ...capped, image: cappedImage } : capped;
  }
  const capped = capStrings(snapshot, {
    title: SNAPSHOT_CAPS.title,
    state: SNAPSHOT_CAPS.state,
    author: SNAPSHOT_CAPS.author,
    path: SNAPSHOT_CAPS.path,
    ref: SNAPSHOT_CAPS.ref,
    capturedAt: SNAPSHOT_CAPS.capturedAt,
  });
  return capped.excerpt === undefined ? capped : { ...capped, excerpt: capExcerpt(capped.excerpt) };
}

const encoder = new TextEncoder();
const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

/** Fields shortened, in this order, when the whole snapshot is over its total size. The title goes last. */
const TRIM_ORDER = ["excerpt", "description", "siteName", "author", "path", "title"] as const;

function withField(snapshot: Snapshot, field: string, value: string): Snapshot {
  const copy: Record<string, unknown> = { ...snapshot };
  copy[field] = value;
  return copy as unknown as Snapshot;
}

function fitTotal(snapshot: Snapshot): Snapshot {
  let current = snapshot;
  for (const field of TRIM_ORDER) {
    const over = jsonBytes(current) - SNAPSHOT_CAPS.totalJsonBytes;
    if (over <= 0) return current;
    const value = (current as unknown as Record<string, unknown>)[field];
    if (typeof value !== "string") continue;
    // Every UTF-16 unit costs at least one byte of JSON, so cutting `over` units always removes `over` bytes.
    current = withField(current, field, truncateText(value, value.length - over));
  }
  return hardFallback(current);
}

/** Optional fields dropped, in this order, if shortening was not enough. */
const DROP_ORDER = ["image", "lines", "ref", "path", "author", "siteName", "description", "excerpt"] as const;
/** Required fields shortened as a last resort. */
const SHRINK_LAST = ["finalUrl", "capturedAt", "state", "title"] as const;

/** The invariant "total JSON <= 16 KB" holds for ANY input: this is what makes it unconditional. */
function hardFallback(snapshot: Snapshot): Snapshot {
  const copy: Record<string, unknown> = Object.fromEntries(Object.entries(snapshot));
  for (const field of DROP_ORDER) {
    if (jsonBytes(copy) <= SNAPSHOT_CAPS.totalJsonBytes) return copy as unknown as Snapshot;
    delete copy[field];
  }
  for (const field of SHRINK_LAST) {
    const over = jsonBytes(copy) - SNAPSHOT_CAPS.totalJsonBytes;
    if (over <= 0) break;
    const value = copy[field];
    if (typeof value === "string") copy[field] = truncateText(value, value.length - over);
  }
  return copy as unknown as Snapshot;
}

/**
 * Enforce the snapshot's hard caps (spec 3.1) at capture. Per-field caps first, then the 16 KB total by shortening
 * fields in a fixed order. It NEVER rejects: a post is never lost because a page had a long title.
 */
export function capSnapshot(snapshot: Snapshot): Snapshot {
  return fitTotal(capFields(cleanText(snapshot)));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * SHA-256 (lower-case hex) over the key-sorted canonical JSON of the rendered fields (spec 3). `capturedAt` is a
 * timestamp, not content, so it is left out: equal hash means `unchanged`.
 */
export async function contentHash(snapshot: Snapshot): Promise<string> {
  const rendered = Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "capturedAt"));
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(rendered)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
