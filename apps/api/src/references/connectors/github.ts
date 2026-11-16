// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The `github` connector (M3.3, spec 3): public issues, pull requests, files with a line range, and CI check runs.
 * `identify` is pure (no I/O): it claims only github.com URLs that name ONE resource (issue, pull request, check run,
 * or a file WITH a line anchor) and answers null for everything else, so those URLs fall through to `web`.
 * resolve/fetchLive cover issues, pull requests and check runs (files with a line range follow).
 *
 * ⚠️ THE ONLY DOOR IS `ctx.fetch` with its `api` path (the guarded door; this file never names the global `fetch`).
 * ⚠️ NO TEXT FROM GITHUB IS EVER CARRIED INTO AN ERROR: a status is named, a body never is.
 * ⚠️ ACCESS AND DIFF ARE KEPT APART: only a definitive 404/410 is `gone`; a 401, a 5xx, a refusal or a spent rate limit says
 * nothing about the resource, so those answer `diff: "unknown"` with no snapshot and the engine retries later.
 */
import {
  capSnapshot,
  ConnectorError,
  contentHash,
  type FetchCtx,
  type FetchedPage,
  type Identified,
  type LiveResult,
  type RepoSnapshot,
  type Resolved,
  type StoredReference,
} from "@thinkersjournal/shared";

import { GithubAppConfigError } from "../github-app-auth";
import { OriginRateLimitedError } from "../origin-limit";

import type { Connector } from "../connector";
import type { InstallationAuth } from "../github-installation-auth";

export interface GithubConnectorOptions {
  /** The installation-token provider. Without it resolve/fetchLive say `unsupported` (identify and deepLink still work). */
  auth?: InstallationAuth;
  /** The clock for `capturedAt`; injected for tests. */
  now?: () => Date;
}

const HOSTS = new Set(["github.com", "www.github.com"]);
const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const REPO = /^[a-z0-9._-]{1,100}$/i;
const NUMBER = /^[1-9][0-9]{0,9}$/;
const ANCHOR = /^#L([1-9][0-9]{0,6})(?:-L([1-9][0-9]{0,6}))?$/;

function found(slug: string, type: string, id: string, path: string): Identified {
  return { kind: "github", canonicalUrl: `https://github.com/${slug}/${path}`, resourceKey: `github:${slug}#${type}:${id}` };
}

/** A file URL names a ref and a path; the ref may contain slashes, so the pair is kept whole (resolve pins the SHA). */
function fileOf(slug: string, rest: string[], url: URL): Identified | null {
  const m = ANCHOR.exec(url.hash);
  if (m === null || rest.length < 2 || rest.some((s) => s === "" || s === "." || s === "..")) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (to < from) return null;
  const where = rest.join("/");
  const range = `L${from}-L${to}`;
  return {
    kind: "github",
    canonicalUrl: `https://github.com/${slug}/blob/${where}#${m[2] === undefined ? `L${from}` : range}`,
    resourceKey: `github:${slug}#file:${where}#${range}`,
  };
}

function identify(url: URL): Identified | null {
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname.toLowerCase()) || url.port !== "") return null;
  const trimmed = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  const seg = trimmed.split("/").slice(1);
  const [owner, repo, kind, ...rest] = seg;
  if (owner === undefined || repo === undefined || kind === undefined) return null;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null;
  const slug = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const [n] = rest;
  const one = rest.length === 1 && n !== undefined && NUMBER.test(n);
  if (kind === "issues" && one) return found(slug, "issue", n, `issues/${n}`);
  if (kind === "pull" && one) return found(slug, "pr", n, `pull/${n}`);
  if (kind === "runs" && one) return found(slug, "check", n, `runs/${n}`);
  if (kind === "blob") return fileOf(slug, rest, url);
  return null;
}

type Kind = "issue" | "pr" | "check";
interface Target {
  slug: string;
  type: Kind;
  num: string;
}

const ENDPOINT: Record<Kind, string> = { issue: "issues", pr: "pulls", check: "check-runs" };
const KEY = /^github:([a-z0-9._-]+\/[a-z0-9._-]+)#(issue|pr|check):([0-9]+)$/;

/** The stored identity back to a target. A file key (or anything unknown) is not handled here: null. */
function targetOf(resourceKey: string): Target | null {
  const m = KEY.exec(resourceKey);
  if (m === null) return null;
  return { slug: m[1] as string, type: m[2] as Kind, num: m[3] as string };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rateLimited(page: FetchedPage): boolean {
  return page.headers["x-ratelimit-remaining"] === "0";
}

/** A non-2xx answer to the one resolve, as a typed error (no upstream text is carried). */
function failure(page: FetchedPage): ConnectorError {
  const s = page.status;
  if (s === 404 || s === 410) return new ConnectorError("not_found", `github answered ${s}`, false);
  const retryable = s === 401 || s === 429 || s >= 500 || (s === 403 && rateLimited(page));
  return new ConnectorError("upstream", `github answered ${s}`, retryable);
}

/** Anything thrown while resolving becomes a ConnectorError (spec 3). */
function asConnectorError(e: unknown): ConnectorError {
  if (e instanceof ConnectorError) return e;
  if (e instanceof GithubAppConfigError) return new ConnectorError("unsupported", "github app is not configured", false);
  return new ConnectorError("upstream", "github request failed", true);
}

function stateOf(t: Target, json: Record<string, unknown>): string | undefined {
  if (t.type === "check") {
    if (json["status"] === "completed") return typeof json["conclusion"] === "string" ? json["conclusion"] : "completed";
    return typeof json["status"] === "string" ? json["status"] : undefined;
  }
  if (t.type === "pr" && json["merged"] === true) return "merged";
  return typeof json["state"] === "string" ? json["state"] : undefined;
}

function snapshotOf(t: Target, json: Record<string, unknown>, at: Date): RepoSnapshot {
  const title = t.type === "check" ? json["name"] : json["title"];
  const state = stateOf(t, json);
  if (typeof title !== "string" || state === undefined) throw new ConnectorError("upstream", "github answer unreadable", false);
  const snapshot: RepoSnapshot = { kind: "github", type: t.type, title, state, capturedAt: at.toISOString() };
  const user = json["user"];
  if (isRecord(user) && typeof user["login"] === "string") snapshot.author = user["login"];
  const body = json["body"];
  if (t.type !== "check" && typeof body === "string" && body !== "") snapshot.excerpt = body;
  const capped = capSnapshot(snapshot);
  if (capped.kind !== "github") throw new ConnectorError("upstream", "github answer unreadable", false);
  return capped;
}

function parseJson(page: FetchedPage): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(page.body);
  } catch {
    throw new ConnectorError("upstream", "github answered unreadable JSON", false);
  }
  if (!isRecord(parsed)) throw new ConnectorError("upstream", "github answered unreadable JSON", false);
  return parsed;
}

/** A state the thing does not leave on its own: closed, merged, a finished check run. */
function isDone(type: Kind, state: string): boolean {
  if (type === "issue") return state === "closed";
  if (type === "pr") return state === "merged" || state === "closed";
  return !["queued", "in_progress", "pending", "waiting", "requested"].includes(state);
}

function etagOf(page: FetchedPage): { etag?: string } {
  const etag = page.headers["etag"];
  return etag === undefined ? {} : { etag };
}

function diffOf(t: Target, previous: StoredReference, next: RepoSnapshot, hash: string): "unchanged" | "changed" | "resolved" {
  if (hash === previous.contentHash) return "unchanged";
  const was = previous.snapshot;
  const wasDone = was !== null && was.kind === "github" && isDone(t.type, was.state);
  return isDone(t.type, next.state) && was !== null && !wasDone ? "resolved" : "changed";
}

/** What a thrown error means for a refresh. Our own limit and a refusal are named; everything else is `error`. */
function accessForError(e: unknown): LiveResult {
  if (e instanceof OriginRateLimitedError) return { access: "rate_limited", diff: "unknown" };
  if (e instanceof ConnectorError && e.code === "blocked_target") return { access: "forbidden", diff: "unknown" };
  return { access: "error", diff: "unknown" };
}

/** The answer to a response that is not a 2xx. Only a definitive 404/410 is `gone`. */
function accessForStatus(page: FetchedPage): LiveResult {
  const s = page.status;
  if (s === 304) return { access: "not_modified", diff: "unchanged" };
  if (s === 404 || s === 410) return { access: "gone", diff: "gone" };
  if (s === 429 || (s === 403 && rateLimited(page))) return { access: "rate_limited", diff: "unknown" };
  if (s === 403 || s === 451) return { access: "forbidden", diff: "unknown" };
  return { access: "error", diff: "unknown" };
}

export function createGithubConnector(opts: GithubConnectorOptions = {}): Connector<"github"> {
  const now = opts.now ?? ((): Date => new Date());
  const { auth } = opts;

  async function get(ctx: FetchCtx, t: Target, etag?: string): Promise<FetchedPage> {
    if (auth === undefined) throw new ConnectorError("unsupported", "github is not configured", false);
    const credential = await auth.credential(ctx);
    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    if (etag !== undefined) headers["if-none-match"] = etag;
    return ctx.fetch(`https://api.github.com/repos/${t.slug}/${ENDPOINT[t.type]}/${t.num}`, {
      api: { credential },
      headers,
      allowedTypes: ["application/json"],
    });
  }

  return {
    kind: "github",
    identify,
    async resolve(id: Identified, ctx: FetchCtx): Promise<Resolved> {
      const t = targetOf(id.resourceKey);
      if (t === null) throw new ConnectorError("unsupported", "github resource kind not supported yet", false);
      let page: FetchedPage;
      try {
        page = await get(ctx, t);
      } catch (e) {
        throw asConnectorError(e);
      }
      if (page.status < 200 || page.status >= 300) throw failure(page);
      const snapshot = snapshotOf(t, parseJson(page), now());
      return { resourceKey: id.resourceKey, snapshot, contentHash: await contentHash(snapshot), ...etagOf(page) };
    },
    async fetchLive(ref: StoredReference, ctx: FetchCtx): Promise<LiveResult> {
      const t = targetOf(ref.resourceKey);
      if (t === null) return { access: "error", diff: "unknown" };
      let page: FetchedPage;
      try {
        page = await get(ctx, t, ref.etag);
      } catch (e) {
        return accessForError(e);
      }
      if (page.status < 200 || page.status >= 300) return accessForStatus(page);
      let snapshot: RepoSnapshot;
      try {
        snapshot = snapshotOf(t, parseJson(page), now());
      } catch {
        return { access: "error", diff: "unknown" };
      }
      const hash = await contentHash(snapshot);
      return { access: "ok", diff: diffOf(t, ref, snapshot, hash), snapshot, contentHash: hash, ...etagOf(page) };
    },
    deepLink(ref): string {
      return ref.canonicalUrl;
    },
  };
}

export const githubConnector = createGithubConnector();
