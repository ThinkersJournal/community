/**
 * The ONLY way this app's admin pages talk to the api's Access-gated `/admin/*`
 * surface. A DELIBERATELY SEPARATE code path from `apiFetch` (src/lib/api.ts),
 * not an option on it — admin identity is a different trust domain from a
 * member session (see apps/api/src/admin/require-admin.ts), and this file
 * having NO cookie-forwarding code at all is what makes that structural
 * rather than a flag someone could accidentally flip.
 *
 * ⚠️ NO CONFUSED DEPUTY: `accessJwt` must be the CALLER'S OWN
 * `Cf-Access-Jwt-Assertion` header, read off `Astro.request` by the page that
 * calls this (see src/pages/admin/queue.astro) and forwarded VERBATIM — never
 * a Worker-held credential, never synthesized. The api independently
 * VERIFIES this JWT's signature against Cloudflare Access's own JWKS
 * (apps/api/src/admin/access-jwt.ts) — this module forwards a credential it
 * cannot forge to a verifier that checks it; it does not assert authority on
 * anyone's behalf.
 *
 * There is no generic `/api/admin/*` browser-facing proxy: every admin page
 * calls this directly, server-side, from its own frontmatter, scoped to
 * exactly the api call that page needs. A member's browser can never reach
 * this code at all — it never ships to the client.
 */
import { env } from "cloudflare:workers";

import { ACCESS_JWT_HEADER, isApiErrorBody, type ApiErrorCode } from "@thinkersjournal/shared";

import { resolveOutgoingBody } from "./outgoing-body";

import type { ApiResponse } from "./api";

const SERVICE_ORIGIN = "https://api.internal";

export interface AdminApiFetchOptions {
  method?: string;
  body?: unknown;
  /** The caller's own verified Access JWT — see this file's header. */
  accessJwt: string;
  /**
   * Forwarded from the browser's own `Origin` header for a mutating call —
   * identical reasoning as `apiFetch`'s `origin` option (src/lib/api.ts):
   * `checkOrigin` on the api side fails closed without one, and this must be
   * what the BROWSER sent, never synthesized from this app's own URL.
   */
  origin?: string;
}

export async function adminApiFetch<T = unknown>(
  path: string,
  options: AdminApiFetchOptions,
): Promise<ApiResponse<T>> {
  const { method = "GET", body, accessJwt, origin } = options;

  const headers = new Headers();
  headers.set(ACCESS_JWT_HEADER, accessJwt);
  if (origin !== undefined) headers.set("Origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");

  const outgoingBody = resolveOutgoingBody(body, undefined);

  const response = await env.API.fetch(`${SERVICE_ORIGIN}${path}`, {
    method,
    headers,
    ...(outgoingBody !== undefined && { body: outgoingBody }),
  });

  const text = await response.text();
  return {
    status: response.status,
    data: parseJson<T>(text),
    text,
    // Admin routes never Set-Cookie (no member session involved) — kept for
    // ApiResponse shape parity, always empty in practice.
    setCookies: response.headers.getSetCookie(),
  };
}

function parseJson<T>(text: string): T | null {
  if (text === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function adminApiErrorCode(response: ApiResponse<unknown>): ApiErrorCode | null {
  if (response.status < 400) return null;
  return isApiErrorBody(response.data) ? response.data.code : null;
}
