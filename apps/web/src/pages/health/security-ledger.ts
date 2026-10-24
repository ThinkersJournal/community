// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * `GET /health/security-ledger` — the PUBLIC readout of the security ledger's
 * liveness (security-alerting spec §2.6 R2), proxied over the Service Binding
 * the way /health/db is. The api answers from ONE KV key and never calls the
 * ledger; this page passes its status through UNCHANGED (a 503 `stale` must
 * reach a monitor as a non-200) and lets the edge hold an `ok` for 60 s with
 * no stale-while-revalidate (`markHealthCacheable`, src/lib/cache.ts). A 503 is
 * not edge-cached by default, so it always reaches the api (one KV read).
 */
import type { APIRoute } from "astro";

import { apiFetch } from "../../lib/api";
import { markHealthCacheable } from "../../lib/cache";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markHealthCacheable({ request: context.request, response: { headers }, cache: context.cache });
  try {
    const response = await apiFetch<unknown>("/health/security-ledger");
    return new Response(response.text, { status: response.status, headers });
  } catch {
    return new Response(JSON.stringify({ status: "api_unreachable" }), { status: 503, headers });
  }
};
