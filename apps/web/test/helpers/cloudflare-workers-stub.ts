/**
 * Node stand-in for the `cloudflare:workers` virtual module, aliased in by
 * vitest.config.ts. `src/lib/api.ts` does `import { env } from "cloudflare:workers"`
 * and calls `env.API.fetch(...)`; here `env` is a plain mutable object that
 * `test/helpers/render-page.ts` fills with a fake `API` binding per render.
 */
export const env: { API?: { fetch: (url: string, init?: RequestInit) => Promise<Response> } } = {};
export const cache = { purge: () => Promise.resolve() };
