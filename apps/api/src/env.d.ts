/**
 * Worker environment bindings.
 *
 * The canonical binding types are generated into `worker-configuration.d.ts` by
 * `wrangler types`, which reads `wrangler.jsonc` and wires both the global `Env`
 * and `Cloudflare.Env` (the type `@cloudflare/vitest-pool-workers` gives the
 * test `env`) from a single shared base. To add a real binding (KV, Durable
 * Object, Hyperdrive), add it to `wrangler.jsonc` and re-run `wrangler types`.
 *
 * This interface is the hand-written extension point for `Env` members that are
 * NOT expressed in `wrangler.jsonc`. It merges (declaration merging) with the
 * generated `Env`. It is intentionally empty for the M0 skeleton.
 */
interface Env {}
