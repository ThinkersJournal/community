// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * SSRF URL guard for the reference engine's generic web connector (spec
 * docs/superpowers/specs/2026-11-09-m3-connector-contract.md section 5, rules 1-2).
 *
 * `assertPublicHttpUrl` is pure and synchronous: it judges a URL by its text. It cannot see what a name resolves to
 * (that is the guarded fetch's DNS check, rule 3) and it runs on every hop of a redirect chain, not just the first URL.
 *
 * Errors: a URL that is not an http(s) URL at all is `invalid_url`; one that is a well-formed http(s) URL we will not
 * touch (credentials, a port outside the allow-list, a private or non-routable host) is `blocked_target`.
 */
import { ConnectorError } from "@thinkersjournal/shared";

const ALLOWED_PORTS: ReadonlySet<string> = new Set(["80", "443", "8080", "8443"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal"] as const;

/** Blocked IPv4 ranges (spec 5 rule 2) as [first address, prefix length]. */
const BLOCKED_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 carrier-grade NAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (cloud metadata lives here)
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved, includes 255.255.255.255
];

function blocked(message: string): ConnectorError {
  return new ConnectorError("blocked_target", message);
}

function inV4Range(address: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((address & mask) >>> 0) === base;
}

function isBlockedV4Number(address: number): boolean {
  return BLOCKED_V4.some(([base, bits]) => inV4Range(address, base, bits));
}

/** One IPv4 component in decimal, 0x-hex or leading-zero octal. null if it is none of those. */
function parseV4Component(part: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8);
  if (/^(0|[1-9][0-9]*)$/.test(part)) return Number.parseInt(part, 10);
  return null;
}

/**
 * The WHATWG URL parser already turns most odd IPv4 spellings into dotted decimal, but the guard must not depend on
 * that: this reads decimal, octal, hex and 1-3 part shorthand forms (`2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`)
 * and returns dotted decimal, or null when `host` is not an IPv4 spelling.
 */
export function normaliseIPv4(host: string): string | null {
  const parts = host.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    const value = parseV4Component(part);
    if (value === null) return null;
    values.push(value);
  }
  const last = values[values.length - 1] ?? 0;
  const lead = values.slice(0, -1);
  if (lead.some((v) => v > 255)) return null;
  if (last >= 256 ** (5 - parts.length)) return null;
  let address = last;
  lead.forEach((v, i) => {
    address += v * 256 ** (3 - i);
  });
  return [address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255].join(".");
}

function dottedToNumber(dotted: string): number {
  return dotted.split(".").reduce((acc, part) => acc * 256 + Number.parseInt(part, 10), 0);
}

function parseStrictV4(text: string): number | null {
  if (!/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(text)) return null;
  const parts = text.split(".").map((p) => Number.parseInt(p, 10));
  return parts.some((p) => p > 255) ? null : dottedToNumber(text);
}

/** Eight 16-bit groups of an IPv6 text address, or null when it does not parse. */
function parseIPv6(text: string): number[] | null {
  let s = text.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseStrictV4(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string | undefined): string[] => (h === undefined || h === "" ? [] : h.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : null;
  const all = rest === null ? head : [...head, ...rest];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  if (rest === null) return head.length === 8 ? head.map((g) => Number.parseInt(g, 16)) : null;
  if (head.length + rest.length > 7) return null;
  const fill = new Array<string>(8 - head.length - rest.length).fill("0");
  return [...head, ...fill, ...rest].map((g) => Number.parseInt(g, 16));
}

function embeddedV4(high: number, low: number): number {
  return high * 65536 + low;
}

function isBlockedV6(g: readonly number[]): boolean {
  const at = (i: number): number => g[i] ?? 0;
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1 and the deprecated ::a.b.c.d form
  if ((at(0) & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((at(0) & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((at(0) & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  const mapped = g.slice(0, 5).every((x) => x === 0) && at(5) === 0xffff; // ::ffff:a.b.c.d
  const nat64 = at(0) === 0x64 && at(1) === 0xff9b && g.slice(2, 6).every((x) => x === 0); // 64:ff9b::/96
  if (mapped || nat64) return isBlockedV4Number(embeddedV4(at(6), at(7)));
  if (at(0) === 0x2002) return isBlockedV4Number(embeddedV4(at(1), at(2))); // 6to4
  return false;
}

/**
 * Is this IP address text (IPv4 in any spelling, or IPv6) in a blocked range? Used on DNS answers. Anything that
 * does not parse counts as blocked: the check fails closed.
 */
export function isBlockedIpAddress(ip: string): boolean {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  if (bare.includes(":")) {
    const groups = parseIPv6(bare);
    return groups === null ? true : isBlockedV6(groups);
  }
  const dotted = normaliseIPv4(bare);
  return dotted === null ? true : isBlockedV4Number(dottedToNumber(dotted));
}

/** A last label that is all digits or 0x-hex can only be meant as a number: refuse rather than guess. */
function looksNumeric(host: string): boolean {
  const label = host.slice(host.lastIndexOf(".") + 1);
  return /^(0x[0-9a-f]*|[0-9]+)$/i.test(label);
}

function assertPublicHost(hostname: string): void {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) throw blocked("IPv6 literals are not allowed");
  if (host === "") throw new ConnectorError("invalid_url", "empty host");
  const dotted = normaliseIPv4(host);
  if (dotted !== null) {
    if (isBlockedV4Number(dottedToNumber(dotted))) throw blocked("blocked IPv4 range");
    return;
  }
  if (looksNumeric(host)) throw blocked("unparsable numeric host");
  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw blocked("local host name");
  if (!host.includes(".")) throw blocked("single-label host name");
}

/**
 * Spec 5 rules 1-2. Returns the parsed URL when it is an http(s) URL with no credentials, an allowed port and a host
 * that is neither a blocked address nor a local name; throws `ConnectorError` otherwise. Call it on EVERY redirect hop.
 */
export function assertPublicHttpUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : new URL(input.href);
  } catch {
    throw new ConnectorError("invalid_url", "not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConnectorError("invalid_url", "not an http(s) URL");
  if (url.username !== "" || url.password !== "") throw blocked("credentials in URL");
  if (url.port !== "" && !ALLOWED_PORTS.has(url.port)) throw blocked("port not allowed");
  assertPublicHost(url.hostname);
  return url;
}
