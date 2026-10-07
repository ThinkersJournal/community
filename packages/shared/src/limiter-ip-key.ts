/**
 * The IP part of a PER-IP rate-limit key (brute-force review 1, I1).
 *
 * ⚠️ IPv6 IS KEYED ON ITS /64, NOT THE FULL ADDRESS. An IPv6 subscriber — a home
 * line, a phone, a cloud VM — is handed at least a /64: 2^64 source addresses it
 * can rotate through at will. A bucket keyed on the full address is therefore one
 * FRESH bucket per request, and a per-IP limiter bounds nothing. The /64 is the
 * smallest unit one subscriber controls, so it is the honest "one host" key. It is
 * not looser than IPv4: many strangers behind one carrier-grade-NAT IPv4 address
 * already share a bucket, and that trade-off is stated at each limiter.
 *
 * - IPv4 (`a.b.c.d`) is returned whole.
 * - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is the IPv4 address it maps, so it shares
 *   that address's bucket.
 * - Any other IPv6 is expanded (`::` filled in, zone id dropped, case and leading
 *   zeros canonicalised) and cut to its first four hextets: `2001:db8:1:2::/64`.
 * - Anything that does not parse is returned UNCHANGED. A malformed value must
 *   never collapse unrelated callers into one shared bucket.
 *
 * Used only by the per-IP-ONLY buckets the brute-force work added (login's
 * `ip:`, reset-password, profile, purge-fail). The older keys (login's
 * `ip:email`, search, signup…) are deliberately unchanged in this PR.
 */
export function limiterIpKey(ip: string): string {
  if (IPV4.test(ip)) return ip;
  if (!ip.includes(":")) return ip;

  const mapped = MAPPED_V4.exec(ip);
  if (mapped !== null && IPV4.test(mapped[1]!)) return mapped[1]!;

  const hextets = expandIpv6(ip.split("%")[0]!);
  if (hextets === null) return ip;
  return `${hextets.slice(0, 4).join(":")}::/64`;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAPPED_V4 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;
const HEXTET = /^[0-9a-f]{1,4}$/i;

/** The 8 hextets of `s`, canonical (lowercase, no leading zeros), or null if `s` is not IPv6. */
function expandIpv6(s: string): string[] | null {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): string[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    return groups.every((g) => HEXTET.test(g)) ? groups : null;
  };
  const head = parse(halves[0]!);
  if (head === null) return null;
  let groups: string[];
  if (halves.length === 2) {
    const tail = parse(halves[1]!);
    if (tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16).toString(16));
}
