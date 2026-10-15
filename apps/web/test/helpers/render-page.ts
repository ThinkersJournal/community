import { experimental_AstroContainer as AstroContainer } from "astro/container";

import { env } from "./cloudflare-workers-stub";

type ApiFetch = (url: string, init?: RequestInit) => Promise<Response> | Response;

export interface RenderPageOptions {
  /** Request URL (path + query select the page's behaviour). */
  url?: string;
  method?: string;
  /** Raw body; sent as application/x-www-form-urlencoded when set. */
  body?: string;
  headers?: Record<string, string>;
  /** Fake `API` Service Binding: called for every `apiFetch` the page makes. */
  api: ApiFetch;
}

/**
 * Renders an `.astro` PAGE to an HTML string under plain Node vitest via
 * Astro's container API, with `cloudflare:workers`' `env.API` replaced by
 * `opts.api`. Returns the Response (page may return a redirect/404 itself).
 */
export async function renderPage(
  page: Parameters<AstroContainer["renderToResponse"]>[0],
  opts: RenderPageOptions,
): Promise<Response> {
  env.API = { fetch: async (u, init) => opts.api(u, init) };
  const container = await AstroContainer.create();
  const request = new Request(opts.url ?? "http://localhost/", {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...opts.headers,
    },
    body: opts.body,
  });
  const res = await container.renderToResponse(page, { request, routeType: "page" });
  if (!(res.headers.get("content-type") ?? "").includes("text/html")) return res;
  // Dev-mode compilation stamps every element with data-astro-source-*/cid
  // attributes; strip them so assertions read like the markup in the source.
  const html = (await res.text()).replace(/ data-astro-(?:source-file|source-loc|cid-[a-z0-9]+)(?:="[^"]*")?/g, "");
  return new Response(html, { status: res.status, headers: res.headers });
}

/** Convenience: JSON Response. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
