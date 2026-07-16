/**
 * The `body` (JSON) / `rawBody` (passthrough) merge for `apiFetch` — pulled out
 * of src/lib/api.ts and given its own test corpus for the same reason
 * src/lib/next-url.ts was: it is a pure function with a security-shaped
 * property (never silently serialize the wrong thing), and api.ts imports `env`
 * from `cloudflare:workers`, which does not resolve outside workerd — this file
 * imports nothing, so test/outgoing-body.test.ts can pin it with a plain Node
 * `vitest run`, no Worker runtime required.
 *
 * ⚠️ THE RULE: `rawBody`, if present, wins outright — `body` is never even
 * inspected. `ApiFetchOptions.rawBody`'s own doc comment says the two are
 * mutually exclusive; every current caller only ever sets one. This function's
 * job is to make "both set" a defined, safe outcome (no accidental double
 * body) rather than a foot-gun the caller has to avoid by convention.
 */
export function resolveOutgoingBody(body: unknown, rawBody: BodyInit | undefined): BodyInit | undefined {
  if (rawBody !== undefined) return rawBody;
  if (body !== undefined) return JSON.stringify(body);
  return undefined;
}
