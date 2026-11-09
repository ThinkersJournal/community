// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The SSRF-guarded fetch: the ONLY door to the network for a reference connector (spec
 * docs/superpowers/specs/2026-11-09-m3-connector-contract.md sections 3.3 and 5). `createGuardedFetch` returns the
 * `FetchCtx.fetch` function. Every request, including each redirect hop, passes: the URL rules (`ssrf.ts`), the
 * self-origin refusal, the DNS check, and the robots.txt check; then the response passes the content-type check and is
 * read through a counting stream under one total deadline.
 *
 * ⚠️ KNOWN LIMIT (spec 5 rule 3): the DNS check resolves the name ourselves (DNS-over-HTTPS) and then `fetch` resolves
 * it again. A Worker cannot pin the connection to the address we checked, so an attacker's DNS server can answer
 * differently the second time (rebinding / TOCTOU). This check narrows the window, it does not close it. Defence in
 * depth is that no response body is ever echoed raw (only capped, parsed fields leave the connector) and that Workers
 * `fetch` leaves from Cloudflare's edge (see the M3.1a PR note on what is and is not verified about that).
 *
 * Every network call goes through the injected `fetchImpl`, so tests use a fake and nothing here touches global fetch.
 */
import { ConnectorError, type FetchCtx, type FetchedPage, type FetchInit } from "@thinkersjournal/shared";

import { assertPublicHttpUrl, isBlockedIpAddress, normaliseIPv4 } from "./ssrf";

export const BOT_USER_AGENT = "ThinkersJournalBot/1.0 (+https://community.thinkersjournal.com/bot)";
export const GUARD_DEFAULTS = {
  timeoutMs: 5000,
  maxBytes: 512 * 1024,
  maxRedirects: 3,
} as const;

/** Fixed public resolver for the DNS check. */
export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
/** Our own host (the api Worker has no public route, apps/api/wrangler.jsonc): pointing at it is `unsupported` (spec 5 rule 8). */
export const DEFAULT_SELF_HOSTS: readonly string[] = [
  "community.thinkersjournal.com",
];

const DEFAULT_TYPES: readonly string[] = ["text/html", "application/xhtml+xml"];
const ROBOTS_TOKEN = "thinkersjournalbot";
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
/** Resolves a host name to its A and AAAA addresses (text). */
export type ResolveHost = (host: string, signal?: AbortSignal) => Promise<string[]>;

export interface GuardedFetchOptions {
  /** The real network call. Production passes `(input, init) => fetch(input, init)`; tests pass a fake. */
  fetchImpl: FetchLike;
  /** Default: DNS-over-HTTPS JSON to `DOH_ENDPOINT` through `fetchImpl`. */
  resolveHost?: ResolveHost;
  /** Default: fetch and honour the origin's robots.txt for our UA. */
  robotsAllowed?: (url: URL, signal: AbortSignal) => Promise<boolean>;
  /** Default: `DEFAULT_SELF_HOSTS`. */
  selfHosts?: readonly string[];
  /** Each of these can only LOWER the contract's limit, never raise it. */
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

interface Config {
  fetchImpl: FetchLike;
  resolveHost: ResolveHost;
  robotsAllowed: ((url: URL, signal: AbortSignal) => Promise<boolean>) | undefined;
  selfHosts: ReadonlySet<string>;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
}

interface Deadline {
  signal: AbortSignal;
  clear(): void;
  race<T>(work: Promise<T>): Promise<T>;
}

interface Call {
  cfg: Config;
  deadline: Deadline;
  robots: Map<string, Promise<boolean>>;
  skipRobots: boolean;
}

function startDeadline(ms: number): Deadline {
  const controller = new AbortController();
  const error = new ConnectorError("timeout", `no complete response within ${ms} ms`);
  const timer = setTimeout(() => controller.abort(error), ms);
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(error), { once: true });
  });
  expired.catch(() => undefined); // raced below; this keeps a late abort from being an unhandled rejection
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
    race: (work) => Promise.race([work, expired]),
  };
}

function toConnectorError(e: unknown, deadline: Deadline): ConnectorError {
  if (e instanceof ConnectorError) return e;
  if (deadline.signal.aborted) return new ConnectorError("timeout", "deadline passed");
  return new ConnectorError("upstream", "request failed", true);
}

function discard(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

async function dnsCheck(call: Call, host: string): Promise<void> {
  if (normaliseIPv4(host) !== null) return; // an IPv4 literal was already range-checked by assertPublicHttpUrl
  let answers: string[];
  try {
    answers = await call.deadline.race(call.cfg.resolveHost(host, call.deadline.signal));
  } catch (e) {
    throw toConnectorError(e, call.deadline);
  }
  if (answers.length === 0) throw new ConnectorError("not_found", "host does not resolve");
  if (answers.some(isBlockedIpAddress)) throw new ConnectorError("blocked_target", "host resolves to a blocked address");
}

async function robotsFor(call: Call, url: URL): Promise<boolean> {
  const injected = call.cfg.robotsAllowed;
  if (injected) return call.deadline.race(injected(url, call.deadline.signal));
  const robotsUrl = new URL("/robots.txt", url.origin);
  try {
    const page = await runHops(
      { ...call, skipRobots: true },
      robotsUrl,
      { allowedTypes: ["*"], overflow: "truncate" },
    );
    if (page.status >= 200 && page.status < 300) return isAllowedByRobots(page.body, url.pathname + url.search);
    return page.status >= 400 && page.status < 500; // no robots.txt: allowed. A 5xx or odd status: be polite, refuse.
  } catch (e) {
    if (e instanceof ConnectorError && e.code === "timeout") throw e;
    return false;
  }
}

async function checkTarget(call: Call, url: URL): Promise<void> {
  if (call.cfg.selfHosts.has(hostOf(url))) throw new ConnectorError("unsupported", "our own origin");
  await dnsCheck(call, hostOf(url));
  if (call.skipRobots) return;
  let verdict = call.robots.get(url.origin);
  if (verdict === undefined) {
    verdict = robotsFor(call, url);
    call.robots.set(url.origin, verdict);
  }
  if (!(await verdict)) throw new ConnectorError("blocked_target", "disallowed by robots.txt");
}

async function send(call: Call, url: URL, init: FetchInit): Promise<Response> {
  if (call.deadline.signal.aborted) throw new ConnectorError("timeout", "deadline passed");
  const headers = new Headers(init.headers);
  headers.set("user-agent", BOT_USER_AGENT);
  if (!headers.has("accept")) headers.set("accept", "text/html,application/xhtml+xml");
  try {
    return await call.deadline.race(
      call.cfg.fetchImpl(url.href, { method: "GET", redirect: "manual", headers, signal: call.deadline.signal }),
    );
  } catch (e) {
    throw toConnectorError(e, call.deadline);
  }
}

function nextHop(res: Response, current: URL): URL {
  const location = res.headers.get("location");
  if (!location) throw new ConnectorError("upstream", "redirect without Location");
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new ConnectorError("invalid_url", "unparsable redirect target");
  }
  if (current.protocol === "https:" && next.protocol === "http:") {
    throw new ConnectorError("blocked_target", "https to http downgrade");
  }
  return next;
}

interface Hop {
  res: Response;
  url: URL;
}

async function followRedirects(call: Call, start: URL, init: FetchInit): Promise<Hop> {
  let current = start;
  for (let followed = 0; ; followed += 1) {
    current = assertPublicHttpUrl(current);
    await checkTarget(call, current);
    const res = await send(call, current, init);
    if (!REDIRECT_STATUSES.has(res.status)) return { res, url: current };
    discard(res);
    if (followed >= call.cfg.maxRedirects) throw new ConnectorError("upstream", "too many redirects");
    current = nextHop(res, current);
  }
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function decode(bytes: Uint8Array, contentType: string): string {
  const label = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Read at most `max` bytes (post-decompression: the runtime hands us the decoded stream), counting as we go. Past the
 * cap it either throws `too_large` or keeps the first `max` bytes, and in both cases cancels the source so the
 * connection stops downloading.
 */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  overflow: "too_large" | "truncate",
  deadline: Deadline,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await deadline.race(reader.read());
      if (done) break;
      const room = max - total;
      if (value.byteLength > room) {
        if (overflow === "too_large") throw new ConnectorError("too_large", `body over ${max} bytes`);
        parts.push(value.subarray(0, room));
        total += room;
        truncated = true;
        break;
      }
      parts.push(value);
      total += value.byteLength;
    }
  } finally {
    const cancelled = reader.cancel().catch(() => undefined);
    if (!deadline.signal.aborted) await cancelled; // a stalled stream must not be able to hold us past the deadline
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, truncated };
}

async function toPage(call: Call, hop: Hop, init: FetchInit): Promise<FetchedPage> {
  const { res, url } = hop;
  const headers = headerRecord(res.headers);
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const base = { status: res.status, finalUrl: url.href, contentType, headers };
  if (res.status < 200 || res.status >= 300) {
    discard(res);
    return { ...base, body: "", truncated: false };
  }
  const media = contentType.split(";")[0]?.trim() ?? "";
  const allowed = init.allowedTypes ?? DEFAULT_TYPES;
  if (!allowed.includes("*") && !allowed.includes(media)) {
    discard(res);
    throw new ConnectorError("unsupported", "content type not accepted");
  }
  const { bytes, truncated } = await readCapped(res.body, call.cfg.maxBytes, init.overflow ?? "too_large", call.deadline);
  return { ...base, body: decode(bytes, contentType), truncated };
}

async function runHops(call: Call, start: URL, init: FetchInit): Promise<FetchedPage> {
  return toPage(call, await followRedirects(call, start, init), init);
}

function resolveConfig(opts: GuardedFetchOptions): Config {
  return {
    fetchImpl: opts.fetchImpl,
    resolveHost: opts.resolveHost ?? createDohResolver(opts.fetchImpl),
    robotsAllowed: opts.robotsAllowed,
    selfHosts: new Set((opts.selfHosts ?? DEFAULT_SELF_HOSTS).map((h) => h.toLowerCase())),
    timeoutMs: Math.min(opts.timeoutMs ?? GUARD_DEFAULTS.timeoutMs, GUARD_DEFAULTS.timeoutMs),
    maxBytes: Math.min(opts.maxBytes ?? GUARD_DEFAULTS.maxBytes, GUARD_DEFAULTS.maxBytes),
    maxRedirects: Math.min(opts.maxRedirects ?? GUARD_DEFAULTS.maxRedirects, GUARD_DEFAULTS.maxRedirects),
  };
}

/** Build the guarded `FetchCtx.fetch`. One deadline covers DNS, robots.txt, every hop and the body read. */
export function createGuardedFetch(opts: GuardedFetchOptions): FetchCtx["fetch"] {
  const cfg = resolveConfig(opts);
  return async (input, init = {}) => {
    const deadline = startDeadline(cfg.timeoutMs);
    const call: Call = { cfg, deadline, robots: new Map(), skipRobots: false };
    try {
      const start = assertPublicHttpUrl(input);
      return await deadline.race(runHops(call, start, init));
    } finally {
      deadline.clear();
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function dohQuery(
  fetchImpl: FetchLike,
  endpoint: string,
  host: string,
  type: "A" | "AAAA",
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const url = `${endpoint}?name=${encodeURIComponent(host)}&type=${type}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { accept: "application/dns-json" }, signal });
  } catch {
    throw new ConnectorError("upstream", "DNS resolver unreachable", true);
  }
  if (!res.ok) {
    discard(res);
    throw new ConnectorError("upstream", `DNS resolver answered ${res.status}`, true);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ConnectorError("upstream", "DNS resolver sent a non-JSON body", true);
  }
  const answers = isRecord(json) && Array.isArray(json.Answer) ? json.Answer : [];
  const wanted = type === "A" ? 1 : 28;
  return answers.flatMap((a: unknown) => (isRecord(a) && a.type === wanted && typeof a.data === "string" ? [a.data] : []));
}

/**
 * DNS-over-HTTPS (JSON API) to a fixed public resolver. CNAME rows are ignored (the resolver follows them and returns
 * the final A/AAAA rows). An empty list means the name does not resolve.
 */
export function createDohResolver(fetchImpl: FetchLike, endpoint: string = DOH_ENDPOINT): ResolveHost {
  return async (host, signal) => {
    const [v4, v6] = await Promise.all([
      dohQuery(fetchImpl, endpoint, host, "A", signal),
      dohQuery(fetchImpl, endpoint, host, "AAAA", signal),
    ]);
    return [...v4, ...v6];
  };
}

interface RobotsRule {
  allow: boolean;
  pattern: string;
}
interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0]?.trim() ?? "";
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (current && value !== "") current.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  return groups;
}

/** `*` matches any run, a trailing `$` anchors the end. Linear: no regex built from untrusted text. */
function patternMatches(rawPattern: string, path: string): boolean {
  const anchored = rawPattern.endsWith("$");
  const segments = (anchored ? rawPattern.slice(0, -1) : rawPattern).split("*");
  const first = segments[0] ?? "";
  if (!path.startsWith(first)) return false;
  let pos = first.length;
  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i] ?? "";
    if (anchored && i === segments.length - 1) return path.length - segment.length >= pos && path.endsWith(segment);
    const at = path.indexOf(segment, pos);
    if (at < 0) return false;
    pos = at + segment.length;
  }
  return anchored ? pos === path.length : true;
}

/**
 * Does the robots.txt text allow our UA to fetch `path` (path plus query)? The group naming our UA wins over `*`; the
 * longest matching rule wins; Allow beats Disallow on a tie; no matching rule means allowed.
 */
export function isAllowedByRobots(robotsTxt: string, path: string): boolean {
  const groups = parseRobots(robotsTxt);
  const ours = groups.filter((g) => g.agents.includes(ROBOTS_TOKEN));
  const chosen = ours.length > 0 ? ours : groups.filter((g) => g.agents.includes("*"));
  let best: RobotsRule | undefined;
  for (const rule of chosen.flatMap((g) => g.rules)) {
    if (!patternMatches(rule.pattern, path)) continue;
    const longer = !best || rule.pattern.length > best.pattern.length;
    const tieAllow = best && rule.pattern.length === best.pattern.length && rule.allow;
    if (longer || tieAllow) best = rule;
  }
  return best ? best.allow : true;
}
