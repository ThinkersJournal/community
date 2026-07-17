import { env } from "cloudflare:test";

/**
 * An `env` whose `bumpEpoch()` always rejects, with `getEpoch()` still REAL.
 *
 * ⚠️ WHY FAULT INJECTION IS THE ONLY WAY TO PIN THESE ORDERINGS. Two routes
 * (`src/routes/signup.ts`, `src/routes/logout.ts`) document an ordering between
 * `bumpEpoch()` and a second, non-transactional side effect, and both call it
 * load-bearing. But `bumpEpoch` is a Durable Object call and is NOT part of the
 * Postgres transaction (signup) or the KV delete (logout), so the two can fail
 * INDEPENDENTLY — and on the SUCCESS path BOTH orderings behave identically.
 * The ordering is therefore invisible to every ordinary test: it only manifests
 * when the bump FAILS. `bumpEpoch` is load-bearing precisely WHEN it fails, so
 * "it is only a crash window" is not a defense.
 *
 * This was not hypothetical. Inverting either route's order left the entire
 * suite green (signup: the M0 account-takeover regression test was among the
 * PASSING tests; logout: 9/9 passed). Both are now pinned by tests that inject
 * this fault. If you are adding a third revoke-then-mutate site, pin it here too.
 *
 * `getEpoch()` stays real because the callers need it: `runMutatingPipeline`
 * reads the epoch to validate the session, and signup stamps it into the new
 * session — breaking it would fail the request for the wrong reason and the test
 * would pass vacuously.
 *
 * The rejection message contains "bumpEpoch" so a test can assert the INJECTED
 * fault is what surfaced, rather than some unrelated error that would let the
 * test pass without exercising the path at all.
 */
export function envWithBrokenBump(): Env {
  return {
    ...env,
    USER_SECURITY: {
      getByName(name: string) {
        const real = env.USER_SECURITY.getByName(name);
        return {
          bumpEpoch: () => Promise.reject(new Error("bumpEpoch is unavailable")),
          getEpoch: () => real.getEpoch(),
        };
      },
    },
  } as unknown as Env;
}
