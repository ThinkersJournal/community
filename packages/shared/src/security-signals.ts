import { limiterIpKey } from "./limiter-ip-key";
import type { SecurityAlertSignal, SignalClass } from "./security-alert";
import type { SecurityEvent, SecurityEventCounting } from "./security-log";

/**
 * What a rule's subject is: one /64 (`ip`; IPv4 whole), one network (`net`: an
 * IPv6 /48 or an IPv4 /24), one account, or the whole site. `ip` and `net`
 * subjects share the `ip:` shards.
 */
export type SubjectKind = "ip" | "net" | "account" | "site";

/** What a rule compares with its threshold. */
export type Measure = "events" | "distinct_email" | "distinct_ip";

export interface SignalRule {
  readonly signal: SecurityAlertSignal;
  readonly signalClass: SignalClass;
  readonly subject: SubjectKind;
  readonly measure: Measure;
  readonly windowMinutes: 10 | 60;
  readonly threshold: number;
  readonly severity: "warning" | "critical";
  readonly matches: (event: SecurityEvent, counting: SecurityEventCounting) => boolean;
}

const LOGIN = "/auth/login";
const RESET = "/auth/reset-password";
const PURGE = "/internal/purge";

const loginFailure = (e: SecurityEvent) => e.route === LOGIN && e.kind === "auth_failure";

/** §1.3's table, as code. Thresholds are open decision D3. Cooldowns and budgets are per class (§2.6). */
export const SIGNAL_RULES: readonly SignalRule[] = [
  // auth_failure only: a 429 is counted by the site storm rule alone, so a 429 flood from rotating /64s
  // writes no per-/64 rows (§2.5).
  { signal: "login_ip_burst", signalClass: "ip_burst", subject: "ip", measure: "events", windowMinutes: 10,
    threshold: 50, severity: "warning", matches: loginFailure },
  { signal: "credential_stuffing", signalClass: "stuffing", subject: "ip", measure: "distinct_email",
    windowMinutes: 10, threshold: 10, severity: "critical", matches: (e, c) => loginFailure(e) && c.email !== undefined },
  { signal: "slow_stuffing", signalClass: "stuffing", subject: "site", measure: "distinct_email",
    windowMinutes: 60, threshold: 150, severity: "critical", matches: (e, c) => loginFailure(e) && c.email !== undefined },
  { signal: "targeted_account", signalClass: "account", subject: "account", measure: "events", windowMinutes: 60,
    threshold: 30, severity: "critical", matches: (e, c) => loginFailure(e) && c.userId !== undefined },
  { signal: "distributed_account_guess", signalClass: "account", subject: "account", measure: "distinct_ip",
    windowMinutes: 60, threshold: 5, severity: "critical", matches: (e, c) => loginFailure(e) && c.userId !== undefined },
  { signal: "purge_secret_failure", signalClass: "purge", subject: "site", measure: "events", windowMinutes: 10,
    threshold: 1, severity: "critical", matches: (e) => e.route === PURGE && e.kind === "auth_failure" },
  // Per network (IPv6 /48, IPv4 /24): probing from one network writes one row per network per minute,
  // not one per request (§2.5).
  { signal: "reset_token_burst", signalClass: "ip_burst", subject: "net", measure: "events", windowMinutes: 10,
    threshold: 20, severity: "warning", matches: (e) => e.route === RESET && e.kind === "auth_failure" },
  { signal: "reset_token_storm", signalClass: "storm", subject: "site", measure: "events", windowMinutes: 60,
    threshold: 100, severity: "warning", matches: (e) => e.route === RESET && e.kind === "auth_failure" },
  { signal: "login_failure_storm", signalClass: "storm", subject: "site", measure: "events", windowMinutes: 10,
    threshold: 300, severity: "warning", matches: loginFailure },
  { signal: "rate_limit_storm", signalClass: "storm", subject: "site", measure: "events", windowMinutes: 10,
    threshold: 500, severity: "warning", matches: (e) => e.kind === "rate_limited" },
  { signal: "missing_client_ip", signalClass: "infra", subject: "site", measure: "events", windowMinutes: 10,
    threshold: 20, severity: "warning",
    matches: (e) => e.ip === null && e.route !== PURGE && e.kind !== "alerting_fault" },
];

/** Counter instances per subject kind. Fixed, so /64 rotation cannot create instances (§2.4). */
export const SHARDS_PER_KIND = 16;

/** One unit of work. `subject` is the /64 (or "none"), the user id, or "site". */
export interface CounterIncrement {
  readonly shard: string;
  readonly signal: SecurityAlertSignal;
  readonly subject: string;
  readonly route: string;
  /** Minutes since the epoch, UTC: the bucket. */
  readonly minute: number;
  readonly member: string | null;
}

/** FNV-1a, 32-bit. Load spreading only; not a security boundary. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The counter instance (`getByName` argument) that owns `subject`. */
export function shardFor(kind: SubjectKind, subject: string): string {
  if (kind === "site") return "site";
  return `${kind === "account" ? "acct" : "ip"}:${fnv1a(subject) % SHARDS_PER_KIND}`;
}

const IPV4_KEY = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * The network an address belongs to: an IPv6 /48 (from its canonical /64 key) or
 * an IPv4 /24 (IPv4-mapped IPv6 included, via limiterIpKey). Anything unparsed is
 * returned unchanged, so it never merges with another caller.
 */
export function networkKey(ip: string): string {
  const k = limiterIpKey(ip);
  if (k.endsWith("::/64")) return `${k.slice(0, -"::/64".length).split(":").slice(0, 3).join(":")}::/48`;
  const v4 = IPV4_KEY.exec(k);
  // Octets over 255 are not an address: returned unchanged, like any unparsed value.
  if (v4?.slice(1).every((o) => Number(o) <= 255)) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  return k;
}

function subjectFor(rule: SignalRule, event: SecurityEvent, counting: SecurityEventCounting): string | null {
  switch (rule.subject) {
    case "site":
      return "site";
    case "ip":
      // An IPv6 client counts on its /64 (limiterIpKey); IPv4 whole. No IP: subject "none".
      return event.ip === null ? "none" : limiterIpKey(event.ip);
    case "net":
      return event.ip === null ? "none" : networkKey(event.ip);
    case "account":
      return counting.userId ?? null;
  }
}

/** Every increment one event produces. Pure: the unit tests' main target. */
export function classify(event: SecurityEvent, at: Date, counting: SecurityEventCounting): CounterIncrement[] {
  const minute = Math.floor(at.getTime() / 60_000);
  const out: CounterIncrement[] = [];
  for (const rule of SIGNAL_RULES) {
    if (!rule.matches(event, counting)) continue;
    const subject = subjectFor(rule, event, counting);
    if (subject === null) continue;
    let member: string | null = null;
    if (rule.measure === "distinct_email") member = counting.email ?? null;
    if (rule.measure === "distinct_ip") member = event.ip === null ? "none" : limiterIpKey(event.ip);
    out.push({ shard: shardFor(rule.subject, subject), signal: rule.signal, subject, route: event.route, minute, member });
  }
  return out;
}
