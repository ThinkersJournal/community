import type { Client } from "pg";
// `pg` is CommonJS; under `nodejs_compat` the robust interop form is the default
// import (`module.exports`) with the constructor read off it as `pg.Client`.
// A named value import (`import { Client } from "pg"`) is not relied on here.
import pg from "pg";

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
  await client.connect();
  try {
    return await fn(client);
  } finally {
    ctx.waitUntil(client.end());
  }
}
