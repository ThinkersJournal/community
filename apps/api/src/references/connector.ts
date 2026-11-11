// SPDX-License-Identifier: MIT OR Apache-2.0
/** The connector interface (spec docs/superpowers/specs/2026-11-09-m3-connector-contract.md section 3). */
import type { FetchCtx, Identified, LiveResult, Resolved, SourceKind, StoredReference } from "@thinkersjournal/shared";

export interface Connector<K extends SourceKind = SourceKind> {
  readonly kind: K;
  /** Pure, no I/O. Does this URL belong to me, and what is its canonical form? null = not mine. */
  identify(url: URL): Identified | null;
  /** The one resolve at post time: fetch, bound, and return a snapshot. Throws ConnectorError, never returns partial. */
  resolve(id: Identified, ctx: FetchCtx): Promise<Resolved>;
  /** Refresh: conditional where the source allows. Returns what the source says now. */
  fetchLive(ref: StoredReference, ctx: FetchCtx): Promise<LiveResult>;
  /** The human link the card opens (always the canonical public URL; never an API URL). */
  deepLink(ref: StoredReference): string;
}
