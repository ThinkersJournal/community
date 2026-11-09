// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The `web` connector: the catch-all for http(s) URLs (spec 3 and 5). It unfurls a page into a bounded snapshot from
 * its Open Graph fields, and refreshes it with a conditional GET.
 *
 * ⚠️ THE ONLY DOOR IS `ctx.fetch` (the SSRF-guarded fetch). This file never names the global `fetch`, and
 * test/connector-door.node.test.ts fails the build if it ever does.
 *
 * ⚠️ ACCESS AND DIFF ARE KEPT APART (spec 3). `fetchLive` says `gone` ONLY for a definitive 404 or 410. A 5xx, a
 * timeout, a 429, our own rate limit or a refusal tells us nothing about whether the page changed, so those answer
 * `diff: "unknown"` and carry no snapshot: the engine leaves the stored live state alone and retries later.
 *
 * ⚠️ THE CANONICAL LINK IS UNTRUSTED. The resource key names the stored row that other posts REUSE (spec 4.1), so a
 * page that claimed another site's URL as its canonical would plant its own snapshot under that key. A canonical is
 * therefore accepted only when it is on the SAME ORIGIN as the page it came from (and never our own origin).
 */
import {
  capSnapshot,
  ConnectorError,
  contentHash,
  type FetchCtx,
  type FetchedPage,
  type FetchInit,
  type Identified,
  type LiveResult,
  type Resolved,
  type StoredReference,
  type WebSnapshot,
} from "@thinkersjournal/shared";

import { DEFAULT_SELF_HOSTS } from "../guarded-fetch";
import { parseOpenGraph } from "../og-parse";
import { OriginRateLimitedError } from "../origin-limit";

import type { Connector } from "../connector";

const KEY_PREFIX = "web:";

function isHttp(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function normalise(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function parseOrNull(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** A non-2xx answer to the one resolve, as a typed error (no upstream text is carried). */
function failure(page: FetchedPage): ConnectorError {
  if (page.status === 404 || page.status === 410) return new ConnectorError("not_found", `page answered ${page.status}`);
  const retryable = page.status === 429 || page.status >= 500;
  return new ConnectorError("upstream", `page answered ${page.status}`, retryable);
}

function snapshotOf(page: FetchedPage, selfHosts: readonly string[]): WebSnapshot {
  const og = parseOpenGraph(page.body, page.finalUrl, selfHosts);
  const snapshot: WebSnapshot = { kind: "web", title: og.title ?? hostOf(new URL(page.finalUrl)), finalUrl: page.finalUrl };
  if (og.description !== undefined) snapshot.description = og.description;
  if (og.siteName !== undefined) snapshot.siteName = og.siteName;
  if (og.image !== undefined) snapshot.image = og.image;
  const capped = capSnapshot(snapshot);
  return capped.kind === "web" ? capped : snapshot;
}

/**
 * The key the row is stored under: the canonical link if the page has one AND it is the same page (same origin and same
 * path; query and hash may differ), else the final URL. Same origin alone is not enough on a shared host: /~evil could
 * otherwise claim /~victim/post and plant its snapshot under that key.
 */
function keyOf(page: FetchedPage, selfHosts: readonly string[]): string {
  const final = new URL(page.finalUrl);
  const raw = parseOpenGraph(page.body, page.finalUrl, selfHosts).canonicalUrl;
  const canonical = raw === undefined ? null : parseOrNull(raw);
  const trusted = canonical !== null && isHttp(canonical) && canonical.origin === final.origin && samePath(canonical, final) && !selfHosts.includes(hostOf(canonical));
  return KEY_PREFIX + normalise(trusted ? canonical : final);
}

/** Same path, ignoring query, hash and one trailing slash (`/a/` and `/a` are the same page). */
function samePath(a: URL, b: URL): boolean {
  const trim = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  return trim(a.pathname) === trim(b.pathname);
}

function conditionalInit(ref: StoredReference): FetchInit {
  const headers: Record<string, string> = {};
  if (ref.etag !== undefined) headers["if-none-match"] = ref.etag;
  if (ref.lastModified !== undefined) headers["if-modified-since"] = ref.lastModified;
  return { headers };
}

/** What a thrown error means for a refresh. Our own limit and a refusal are named; everything else is `error`. */
function accessForError(e: ConnectorError): LiveResult {
  if (e instanceof OriginRateLimitedError) return { access: "rate_limited", diff: "unknown" };
  return e.code === "blocked_target" ? { access: "forbidden", diff: "unknown" } : { access: "error", diff: "unknown" };
}

/** The answer to a response that is not a 2xx page. Only a definitive 404/410 is `gone`. */
function accessForStatus(status: number): LiveResult {
  if (status === 304) return { access: "not_modified", diff: "unchanged" };
  if (status === 404 || status === 410) return { access: "gone", diff: "gone" };
  if (status === 401 || status === 403) return { access: "forbidden", diff: "unknown" };
  if (status === 429) return { access: "rate_limited", diff: "unknown" };
  return { access: "error", diff: "unknown" };
}

function validators(page: FetchedPage): { etag?: string; lastModified?: string } {
  const out: { etag?: string; lastModified?: string } = {};
  const etag = page.headers["etag"];
  const lastModified = page.headers["last-modified"];
  if (etag !== undefined) out.etag = etag;
  if (lastModified !== undefined) out.lastModified = lastModified;
  return out;
}

async function liveFrom(ref: StoredReference, page: FetchedPage, selfHosts: readonly string[]): Promise<LiveResult> {
  const snapshot = snapshotOf(page, selfHosts);
  const hash = await contentHash(snapshot);
  return { access: "ok", diff: hash === ref.contentHash ? "unchanged" : "changed", snapshot, contentHash: hash, ...validators(page) };
}

export function createWebConnector(selfHosts: readonly string[] = DEFAULT_SELF_HOSTS): Connector<"web"> {
  const ownHosts = selfHosts.map((h) => h.toLowerCase());
  return {
    kind: "web",

    identify(url: URL): Identified | null {
      if (!isHttp(url) || ownHosts.includes(hostOf(url))) return null;
      const canonicalUrl = normalise(url);
      return { kind: "web", canonicalUrl, resourceKey: KEY_PREFIX + canonicalUrl };
    },

    async resolve(id: Identified, ctx: FetchCtx): Promise<Resolved> {
      const page = await ctx.fetch(id.canonicalUrl);
      if (page.status < 200 || page.status >= 300) throw failure(page);
      const snapshot = snapshotOf(page, ownHosts);
      return { resourceKey: keyOf(page, ownHosts), snapshot, contentHash: await contentHash(snapshot), ...validators(page) };
    },

    async fetchLive(ref: StoredReference, ctx: FetchCtx): Promise<LiveResult> {
      let page: FetchedPage;
      try {
        page = await ctx.fetch(ref.canonicalUrl, conditionalInit(ref));
      } catch (e) {
        if (e instanceof ConnectorError) return accessForError(e);
        throw e;
      }
      if (page.status < 200 || page.status >= 300) return accessForStatus(page.status);
      return liveFrom(ref, page, ownHosts);
    },

    deepLink(ref: StoredReference): string {
      return ref.canonicalUrl;
    },
  };
}

export const webConnector = createWebConnector();
