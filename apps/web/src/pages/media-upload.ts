/**
 * `POST /media-upload` — the same-origin proxy the editor uploads through.
 *
 * ⚠️ WHY A PROXY AND NOT A DIRECT CALL. The api has NO public route (and gets
 * `workers_dev: false` at launch): the browser can only ever talk to `web`. That
 * is the topology's whole security property — every mutating request is
 * same-origin by construction, which is what makes the api's Origin allowlist
 * meaningful (apps/api/src/auth/csrf.ts). So the bytes come here and go on over
 * the Service Binding.
 *
 * ⚠️ THE BODY IS STREAMED, NOT BUFFERED. `context.request.body` is passed
 * straight through via `apiFetch`'s `rawBody` option: buffering a 15MB upload
 * here would be a 15MB allocation in a 128MB Worker, on top of the one the api
 * makes. The api enforces the cap (it is the one that must — this Worker's
 * checks are convenience, not defense; see apps/api/src/routes/media.ts).
 *
 * ⚠️ NOTHING IS VALIDATED HERE. The sniff, the size cap, the quota and the
 * transform ALL live in the api (apps/api/src/routes/media.ts). Duplicating any
 * of them here would create a second copy to drift, and this Worker is not the
 * trust boundary.
 */
import { apiFetch, applyCookies } from "../lib/api";
import { markPrivate } from "../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  // ⚠️ AN APIRoute's `context` has NO `.response` — that property exists only
  // on the `AstroGlobal` a PAGE gets (see src/lib/csp.ts's header for the same
  // correction, made there for the identical reason). An endpoint's return
  // value straight-up BECOMES the response, so there is no pre-existing
  // response object to mutate; instead a real `Headers` is built here and
  // handed to `markPrivate` through a small CacheContext-shaped wrapper, then
  // reused as the actual response's headers below.
  const headers = new Headers({ "content-type": "application/json" });

  // Per-viewer by definition — an upload is an authenticated act, and this
  // route's response can carry a cleared session cookie. Never cacheable.
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  const response = await apiFetch<unknown>("/media", {
    method: "POST",
    // Forwards the session cookie — the api resolves the uploader from it.
    request: context.request,
    // ⚠️ The BROWSER's Origin, verbatim. NEVER Astro.url.origin / a synthesized
    // value — that would launder a cross-site request into an allowlisted one.
    // See src/lib/api.ts's `origin` doc comment for the login-CSRF incident
    // this guards against.
    origin: context.request.headers.get("Origin") ?? "",
    csrfToken: context.request.headers.get("X-CSRF-Token") ?? "",
    // The raw upload bytes, streamed through untouched — see the file header.
    rawBody: context.request.body ?? undefined,
  });

  // The api can clear the session cookie on a revoked session (the mutating
  // pipeline's epoch check) — propagate it on every response path, success or
  // not, same as every other page that calls apiFetch for a mutation.
  applyCookies(headers, response.setCookies);

  return new Response(response.text, { status: response.status, headers });
};
