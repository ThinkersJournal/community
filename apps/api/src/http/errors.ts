/**
 * The ONE way this Worker builds a non-2xx response. See the envelope contract
 * in packages/shared/src/errors.ts.
 *
 * ⚠️ Every error path goes through here. apps/api/test/error-envelope.test.ts
 * is the backstop: it drives each reachable error path and asserts the shape,
 * so a route that hand-rolls `new Response("nope", { status: 400 })` fails
 * there rather than shipping a fifth dialect.
 */
import type { ApiErrorCode } from "@thinkersjournal/shared";

export interface ErrorResponseInit {
  /**
   * ⚠️ `Record<string, string>`, DELIBERATELY NARROWER THAN `HeadersInit` —
   * the same reasoning as src/auth/pipeline.ts's `unauthorized`: this object is
   * SPREAD, and spreading a `Headers` INSTANCE yields `{}` while spreading a
   * `string[][]` yields index keys. Both type-check as `HeadersInit` and both
   * would SILENTLY DROP the revocation path's `Set-Cookie`.
   */
  headers?: Record<string, string>;
  message?: string;
  fields?: string[];
}

export function errorResponse(
  code: ApiErrorCode,
  status: number,
  init: ErrorResponseInit = {},
): Response {
  const body: Record<string, unknown> = { code };
  if (init.message !== undefined) body.message = init.message;
  if (init.fields !== undefined) body.fields = init.fields;

  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/**
 * The one 404 every unmatched path gets — and the one the gated `__test`
 * routes fall through to when `TEST_ROUTES` is unset. ⚠️ Those two MUST stay
 * byte-identical: a distinguishable 404 confirms the test route exists, which
 * is exactly what its gate is for (src/routes/__test.ts).
 */
export function notFoundResponse(): Response {
  return errorResponse("NOT_FOUND", 404);
}
