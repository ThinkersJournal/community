// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * BROWSER read hop for the "updated Terms" notice (ROADMAP R12). Forwards the session cookie to
 * the api's `GET /account/terms` and reports whether this viewer still has to accept the
 * current Terms. Never cached (markPrivate): the nav that consumes it renders on cached pages,
 * so this per-viewer state stays client-side. Anything but a clean 200 answers "no notice".
 */
import { apiFetch } from "../../lib/api";
import { markPrivate } from "../../lib/cache";

import type { TermsStatus } from "@thinkersjournal/shared";
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const res = await apiFetch<TermsStatus>("/account/terms", { request: context.request });
  const needsAcceptance = res.status === 200 && res.data !== null && res.data.needsAcceptance === true;
  return new Response(JSON.stringify({ needsAcceptance }), { status: 200, headers });
};
