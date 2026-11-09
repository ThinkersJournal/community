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
  /** Lower-case media types accepted on a 2xx response. Default: html and xhtml. */
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
  excerptChars: 4096,
  excerptLines: 40,
  totalJsonBytes: 16 * 1024,
} as const;

export function capSnapshot(_snapshot: Snapshot): Snapshot {
  throw new Error("not implemented");
}

export async function contentHash(_snapshot: Snapshot): Promise<string> {
  throw new Error("not implemented");
}
