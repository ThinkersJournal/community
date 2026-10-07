import { classify, SIGNAL_RULES } from "./security-signals";
import type { CounterIncrement } from "./security-signals";
import type { SecurityAlertSignal } from "./security-alert";
import type { SecurityEvent, SecurityEventCounting } from "./security-log";

/** One aggregated row: every increment with the same key, summed. */
export interface CounterRow {
  readonly signal: SecurityAlertSignal;
  readonly subject: string;
  readonly route: string;
  readonly minute: number;
  readonly n: number;
  /** Distinct members seen (raw; hashed by the counter, never stored raw). */
  readonly members: readonly string[];
}

/** What one `record` RPC carries to one counter instance. */
export interface CounterBatch {
  readonly rows: readonly CounterRow[];
  /** Only ever non-zero in the batch for `site`: increments dropped by the subject cap. */
  readonly overflowEvents: number;
}

/** The counter DO's RPC surface (`SecurityCounterDO`). */
export interface SecurityCounterRpc {
  record(batch: CounterBatch): Promise<void>;
}

/** What one request lends the buffer: its `waitUntil`, and a way to reach a counter instance. */
export interface SecurityRequestScope {
  waitUntil(promise: Promise<unknown>): void;
  stubFor(shard: string): SecurityCounterRpc;
}

/** One flush per isolate at most this often. */
export const FLUSH_DELAY_MS = 5_000;
/**
 * Distinct subjects per flush, per kind; increments for further subjects become
 * `overflowEvents`. Separate caps, so /64 rotation cannot crowd out accounts.
 * Plan ruling I-10 (PM): `net` (reset-token networks) has its OWN cap, so a
 * reset-token flood (class ip_burst) can never push a stuffing /64 (class
 * stuffing) into overflow — the C1 rule. They still share the `ip:` shards.
 */
export const MAX_SUBJECTS_PER_FLUSH = { ip: 50, net: 50, acct: 200 } as const;

type CapKind = keyof typeof MAX_SUBJECTS_PER_FLUSH;

/** Signals whose subject is a network (§2.3 `SubjectKind` "net"). */
const NET_SIGNALS: ReadonlySet<string> = new Set(SIGNAL_RULES.filter((r) => r.subject === "net").map((r) => r.signal));

function capKindOf(inc: CounterIncrement): CapKind {
  if (inc.shard.startsWith("acct:")) return "acct";
  return NET_SIGNALS.has(inc.signal) ? "net" : "ip";
}
/** Distinct members kept per row: 2 × the largest distinct threshold (slow_stuffing, 150). */
export const MAX_MEMBERS_PER_ROW = 300;

interface MutableRow {
  readonly shard: string;
  readonly row: Omit<CounterRow, "n" | "members">;
  n: number;
  readonly members: Set<string>;
}

/**
 * Per-isolate aggregation. Volume costs memory only up to the caps above, and DO
 * calls only at flush time: at most one `record` per counter instance per flush,
 * and there are 16 + 16 + 1 instances (§2.4), so ≤ 33 RPCs per isolate per 5 s
 * however many events arrive and however many /64s they come from.
 */
export class SecurityEventBuffer {
  private rows = new Map<string, MutableRow>();
  private subjects = { ip: new Set<string>(), net: new Set<string>(), acct: new Set<string>() };
  private overflow = 0;
  private timerArmed = false;

  constructor(private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  add(event: SecurityEvent, at: Date, counting: SecurityEventCounting, scope: SecurityRequestScope): void {
    for (const inc of classify(event, at, counting)) this.addOne(inc);
    if (!this.timerArmed) {
      this.timerArmed = true;
      // The flush runs inside THIS request's waitUntil, and creates its stubs there.
      scope.waitUntil(
        this.sleep(FLUSH_DELAY_MS).then(() => {
          this.timerArmed = false;
          return this.flush(scope);
        }),
      );
    }
  }

  private addOne(inc: CounterIncrement): void {
    if (inc.shard !== "site") {
      const kind = capKindOf(inc);
      const seen = this.subjects[kind];
      if (!seen.has(inc.subject)) {
        if (seen.size >= MAX_SUBJECTS_PER_FLUSH[kind]) {
          this.overflow += 1;
          return;
        }
        seen.add(inc.subject);
      }
    }
    const key = `${inc.shard}|${inc.signal}|${inc.subject}|${inc.route}|${inc.minute}`;
    let row = this.rows.get(key);
    if (row === undefined) {
      row = {
        shard: inc.shard,
        row: { signal: inc.signal, subject: inc.subject, route: inc.route, minute: inc.minute },
        n: 0,
        members: new Set<string>(),
      };
      this.rows.set(key, row);
    }
    row.n += 1;
    if (inc.member !== null && row.members.size < MAX_MEMBERS_PER_ROW) row.members.add(inc.member);
  }

  /** Send everything waiting, one `record` call per counter instance. Never rejects. */
  async flush(scope: SecurityRequestScope): Promise<void> {
    const rows = this.rows;
    const overflowEvents = this.overflow;
    this.rows = new Map();
    this.subjects = { ip: new Set<string>(), net: new Set<string>(), acct: new Set<string>() };
    this.overflow = 0;
    const byShard = new Map<string, CounterRow[]>();
    for (const r of rows.values()) {
      const list = byShard.get(r.shard) ?? [];
      list.push({ ...r.row, n: r.n, members: [...r.members] });
      byShard.set(r.shard, list);
    }
    if (overflowEvents > 0 && !byShard.has("site")) byShard.set("site", []);
    const results = await Promise.allSettled(
      [...byShard].map(([shard, list]) =>
        scope.stubFor(shard).record({ rows: list, overflowEvents: shard === "site" ? overflowEvents : 0 }),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      // Counts only: a shard's rows carry IP prefixes and user ids.
      console.error("security-counter: record failed", { failed, of: results.length });
    }
  }
}
