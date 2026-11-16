// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The `github` connector (M3.3, spec 3): public issues, pull requests, files with a line range, and CI check runs.
 * `identify` is pure (no I/O): it claims only github.com URLs that name ONE resource (issue, pull request, check run,
 * or a file WITH a line anchor) and answers null for everything else, so those URLs fall through to `web`.
 * resolve/fetchLive are stubs until the next commits.
 */
import { ConnectorError, type Identified, type LiveResult, type Resolved } from "@thinkersjournal/shared";

import type { Connector } from "../connector";

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

export function createGithubConnector(): Connector<"github"> {
  return {
    kind: "github",
    identify,
    resolve(): Promise<Resolved> {
      return Promise.reject(new ConnectorError("unsupported", "github resolve not built yet"));
    },
    fetchLive(): Promise<LiveResult> {
      return Promise.reject(new ConnectorError("unsupported", "github fetchLive not built yet"));
    },
    deepLink(ref): string {
      return ref.canonicalUrl;
    },
  };
}

export const githubConnector = createGithubConnector();
