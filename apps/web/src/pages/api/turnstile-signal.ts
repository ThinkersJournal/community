/**
 * `POST /api/turnstile-signal` — the countable client-side failure signal
 * for the Turnstile widget (PM task, 2026-09-24, following the #89
 * outage-that-wasn't: "nothing measures Turnstile failure rate today...
 * make the error/timeout callbacks emit something countable").
 *
 * There was no existing client-side telemetry/analytics mechanism anywhere
 * in this app to reuse — checked first, found none — so this is the
 * smallest viable one: a fire-and-forget beacon that logs a structured,
 * greppable line via `console.error`, the SAME "Workers Logs is the
 * observability surface" pattern this codebase already relies on elsewhere
 * (postmark.ts's failure logs, build-web.mjs's unconditional WORKERS_CI
 * line). No new binding, no new KV namespace, no new dependency — an
 * operator counts occurrences with `wrangler tail | grep` or a Workers Logs
 * query on the structured message, exactly like every other failure signal
 * in this repo.
 *
 * ⚠️ NEVER logs the Turnstile token or any part of it — there is nothing in
 * this request body that COULD be a token (see `TurnstileSignalKind`
 * below), by construction, not by care taken here.
 */
import { markPrivate } from "../../lib/cache";

import type { APIRoute } from "astro";

export const prerender = false;

const KINDS = new Set(["widget_error", "widget_timeout"]);

export const POST: APIRoute = async (context) => {
  const headers = new Headers({ "content-type": "application/json" });
  markPrivate({ request: context.request, response: { headers }, cache: context.cache });

  let kind = "unknown";
  try {
    const body = (await context.request.json()) as { kind?: unknown };
    if (typeof body.kind === "string" && KINDS.has(body.kind)) kind = body.kind;
  } catch {
    // A malformed/empty body still counts as a signal worth logging — the
    // widget clearly called back, even if the body didn't parse.
  }

  // Referer tells us WHICH page (signup vs forgot-password) without logging
  // anything about the visitor — same non-identifying shape as every other
  // structured log line in this codebase.
  console.error("turnstile client-side failure", {
    kind,
    page: context.request.headers.get("Referer") ?? null,
  });

  return new Response(null, { status: 204, headers });
};
