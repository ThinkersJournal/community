import type { Client } from "pg";
// `pg` is CommonJS; under `nodejs_compat` the robust interop form is the default
// import (`module.exports`) with the constructor read off it as `pg.Client`.
// A named value import (`import { Client } from "pg"`) is not relied on here.
import pg from "pg";

/**
 * `BEGIN` a transaction with its resource holds BOUNDED. Use this instead of a
 * bare `BEGIN` for every transaction.
 *
 * ⚠️ WHY THE SETTINGS LIVE IN THE `BEGIN` AND NOT ON THE CONNECTION. Hyperdrive
 * pools in TRANSACTION MODE and `RESET`s a connection when it returns to the
 * pool, so there is no durable "session" to configure: per Cloudflare's docs, a
 * `SET` only takes effect "for the duration of a transaction or a query", and a
 * single Worker invocation may obtain MULTIPLE connections. Startup-packet
 * options (`pg.Client({ options: "-c lock_timeout=..." })`) are therefore NOT a
 * usable channel either — they configure the client's connection to Hyperdrive,
 * not the origin backend Hyperdrive actually runs our statements on. That form
 * *does* work in local dev (which connects straight to Postgres, with no pooler
 * in between) and would silently be a no-op in production — the worst kind of
 * safety setting. `SET LOCAL` inside the transaction is the supported mechanism,
 * it costs no extra round trip (batched into this one simple-query `BEGIN`), and
 * it cannot leak to another Worker isolate because it reverts at COMMIT/ROLLBACK.
 *
 * ⚠️ WHY BOUND THEM AT ALL. `signup`'s transaction holds a ROW LOCK across a
 * Durable Object RPC (the epoch bump, which must precede the COMMIT — see
 * src/routes/signup.ts). That is the only place in the Worker where a Postgres
 * lock is held across a NON-POSTGRES network call, and it means a DO that HANGS
 * (rather than errors) would otherwise pin that row's lock with nothing on the
 * database side bounding it — every concurrent signup for that address would
 * queue behind it. Only workerd's request limit would eventually intervene, and
 * that is an indirect backstop for a database-side resource.
 *
 *   • `lock_timeout = 5s` — how long a statement waits to ACQUIRE a lock before
 *     failing with `55P03`. Legitimate contention here is one concurrent signup's
 *     transaction (~3 round trips + one DO RPC, comfortably sub-second), so 5s is
 *     a large margin over the real worst case while still failing cleanly well
 *     inside the Worker's request budget.
 *   • `idle_in_transaction_session_timeout = 10s` — the one that actually
 *     addresses the hang: it bounds a transaction sitting IDLE with a lock held,
 *     which is exactly the shape of a stalled DO call. Postgres terminates the
 *     backend (`25P03`), releasing the lock; our transaction then cannot commit,
 *     so the failure is fail-safe (no password write). A DO round trip is
 *     normally single-digit ms — at 10s something is genuinely broken.
 *
 * The ordering is deliberate: `idle` (10s) > `lock` (5s), so a waiter blocked on
 * a hung holder gives up with a clean error before the holder is reaped. The
 * property being bought is that the LOCK IS ALWAYS RELEASED and the system
 * cannot wedge — not that any particular request survives.
 */
export const BEGIN_BOUNDED_TX = `BEGIN;
   SET LOCAL lock_timeout = '5s';
   SET LOCAL idle_in_transaction_session_timeout = '10s'`;

/**
 * Runs `fn` with a connected `pg.Client` reached through a Hyperdrive binding,
 * then ends the client in the background via `ctx.waitUntil` so the response can
 * return without blocking on socket teardown.
 *
 * A `Client` is used, NOT a `Pool`: Hyperdrive IS the connection pool, so a
 * `pg.Pool` layered on top would double-pool.
 *
 * @param hd  a Hyperdrive binding. Pass `HYPERDRIVE_FRESH` (cache-disabled) for
 *   any auth / session / permission / dup-email / verify / read-after-write
 *   query; pass `HYPERDRIVE_CACHED` (60s cache) ONLY for public feeds/listings.
 *   Hyperdrive never invalidates on write, so a cached auth/verify read is a
 *   real security bug.
 * @param ctx the request's `ExecutionContext`; used to `waitUntil(client.end())`
 *   so socket teardown does not block the response.
 * @param fn  callback invoked with the connected client; its result is returned.
 */
export async function withClient<T>(
  hd: Hyperdrive,
  ctx: ExecutionContext,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: hd.connectionString });

  // ⚠️ REQUIRED, NOT DEFENSIVE NOISE. `pg` routes a connection-level failure to
  // the in-flight query's promise — but when NOTHING is in flight it emits an
  // 'error' EVENT instead, and an EventEmitter 'error' with no listener is
  // rethrown as an unhandled exception rather than failing just this request.
  //
  // That is not hypothetical here: `BEGIN_BOUNDED_TX`'s
  // `idle_in_transaction_session_timeout` exists precisely to have Postgres
  // terminate a transaction that is idle mid-flight (signup awaiting the epoch
  // bump's DO RPC), and the resulting FATAL `25P03` arrives with no query
  // outstanding — verified against Postgres 18, where it crashed a bare script
  // for exactly this reason. Logging it here keeps the failure attributable to
  // one request: the next statement (the COMMIT) then rejects normally, the
  // transaction rolls back, and nothing was written. Fail-safe.
  client.on("error", (err) => {
    console.error("pg client connection error", err);
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    // `end()` on a connection Postgres already terminated can itself reject; an
    // unhandled rejection inside `waitUntil` would be reported INSTEAD of the
    // error that actually failed the request. Same reasoning as the ROLLBACK's
    // own try/catch in src/routes/signup.ts: teardown must never replace the
    // root cause. Logged, never silently swallowed.
    ctx.waitUntil(
      client.end().catch((err: unknown) => {
        console.error("pg client end failed", err);
      }),
    );
  }
}
